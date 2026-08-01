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

import copy
import hashlib
import hmac
import json
import os
import re
import secrets
import shlex
import time
from pathlib import Path

ALLOW, PROMPT, FORBIDDEN = "allow", "prompt", "forbidden"
# PROMPT is fail-closed.  The shared wrapper must not dispatch until the desktop
# bridge has shown a PermissionCard and approved the exact challenge through the
# authenticated backend endpoint.
_SEVERITY = {ALLOW: 0, PROMPT: 1, FORBIDDEN: 2}

APPROVAL_ARG = "_catgo_approval_id"
APPROVAL_TTL_SECONDS = 300
_APPROVAL_SECRET_ENV = "CATGO_VERIFY_APPROVAL_SECRET_FILE"


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
IRREVERSIBLE = {"catgo_workflow", "catgo_workflow_engine", "catgo_campaign"}
# (tool, action) pairs that actually submit; other actions of the same tool are benign
_IRREVERSIBLE_ACTIONS = {
    "submit", "run", "execute", "start", "resume", "retry",
}
# Result-release actions are reversible as files, but not epistemically reversible:
# once a campaign report is emitted it can be copied/cited as a conclusion. Keep this
# registry explicit so read-only status/results calls remain usable for diagnosis.
_RESULT_RELEASE_ACTIONS = {
    ("catgo_campaign", "report"),
}

# Scheduler submission commands reachable through ``catgo_terminal``.  The
# terminal is intentionally a general-purpose escape hatch, but that must not
# also be an escape hatch around the numeric-result verification ledger.  Keep
# this list to commands that start scheduler work; diagnostics such as squeue,
# qstat, sacct, tail, and grep remain free.
_SCHEDULER_SUBMIT_COMMANDS = {
    "sbatch",          # Slurm
    "salloc",          # Slurm interactive allocation
    "srun",            # Slurm job/step launch (allocates when outside a job)
    "qsub",            # PBS / Torque / SGE / Cobalt
    "bsub",            # LSF
    "msub",            # Moab
    "llsubmit",        # LoadLeveler
    "pjsub",           # Fujitsu PJM
    "condor_submit",   # HTCondor
}
_SHELL_COMMANDS = {"sh", "bash", "dash", "zsh", "ksh", "csh", "tcsh", "fish"}
_SHELL_CONTROL = {"!", "{", "}", "if", "then", "elif", "else", "while", "until", "do"}
_SHELL_SEPARATORS = {";", ";;", "&&", "||", "|", "|&", "&", "(", ")", "\n"}
_REDIRECTIONS = {"<", ">", ">>", "<<", "<<<", "<>", ">&", "<&", ">|"}
_ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_SEND_KEYS_ENTER_RE = re.compile(r"<enter>|[\r\n]", re.IGNORECASE)


def _command_basename(token):
    """Return a Unix command basename without consulting the local filesystem."""
    return str(token or "").rstrip("/").rsplit("/", 1)[-1].lower()


def _shell_tokens(command):
    """Best-effort shell lexer with command separators preserved.

    Invalid/incomplete shell text cannot execute through ``run`` and therefore
    is not classified as a submission.  The renderer still applies its normal
    user-approval path to the terminal request.
    """
    try:
        lexer = shlex.shlex(
            str(command or ""),
            posix=True,
            punctuation_chars=";&|()<>\n",
        )
        lexer.whitespace_split = True
        # Preserve newlines as command boundaries.  ``#`` keeps ordinary shell
        # comments from turning examples such as ``echo ok # sbatch ...`` into
        # false positives.
        lexer.whitespace = " \t\r"
        lexer.commenters = "#"
        return list(lexer)
    except ValueError:
        return []


def _simple_commands(tokens):
    """Split lexer tokens at shell control operators."""
    current = []
    for token in tokens:
        if token in _SHELL_SEPARATORS:
            if current:
                yield current
                current = []
        else:
            current.append(token)
    if current:
        yield current


def _strip_command_prefix(tokens):
    """Drop assignments, control keywords, and leading redirections."""
    tokens = list(tokens)
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in _SHELL_CONTROL or _ASSIGNMENT_RE.match(token):
            index += 1
            continue
        if token.isdigit() and index + 1 < len(tokens) and tokens[index + 1] in _REDIRECTIONS:
            index += 3  # fd, redirection, destination
            continue
        if token in _REDIRECTIONS:
            index += 2  # redirection, destination
            continue
        break
    return tokens[index:]


def _skip_wrapper_options(tokens, *, value_options=()):
    """Return a wrapper's command tail after conservative option parsing."""
    tokens = list(tokens)
    index = 0
    value_options = set(value_options)
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            return tokens[index + 1:]
        if _ASSIGNMENT_RE.match(token):
            index += 1
            continue
        if not token.startswith("-") or token == "-":
            break
        option = token.split("=", 1)[0]
        if option in value_options and "=" not in token:
            index += 2
        else:
            index += 1
    return tokens[index:]


def _simple_starts_scheduler_job(tokens, depth=0):
    """Whether one simple command launches a scheduler submission."""
    if depth > 8:
        return False
    tokens = _strip_command_prefix(tokens)
    if not tokens:
        return False
    executable = _command_basename(tokens[0])
    tail = tokens[1:]

    if executable in _SCHEDULER_SUBMIT_COMMANDS:
        return True
    if executable == "flux":
        flux_tail = _skip_wrapper_options(tail)
        if not flux_tail:
            return False
        subcommand = str(flux_tail[0]).lower()
        if subcommand in {"submit", "batch", "run"}:
            return True
        return (
            subcommand == "mini"
            and len(flux_tail) > 1
            and str(flux_tail[1]).lower() in {"submit", "batch", "run"}
        )

    # A shell's -c/-lc argument is a fresh command language; recurse into it.
    if executable in _SHELL_COMMANDS:
        for index, token in enumerate(tail):
            if token == "-c" or (
                token.startswith("-")
                and not token.startswith("--")
                and "c" in token[1:]
            ):
                if index + 1 < len(tail):
                    return _command_starts_scheduler_job(tail[index + 1], depth + 1)
                return False
        return False

    if executable == "env":
        for index, token in enumerate(tail):
            if token in {"-S", "--split-string"} and index + 1 < len(tail):
                if _command_starts_scheduler_job(tail[index + 1], depth + 1):
                    return True
            if token.startswith("--split-string="):
                if _command_starts_scheduler_job(token.split("=", 1)[1], depth + 1):
                    return True
        nested = _skip_wrapper_options(
            tail,
            value_options={"-u", "--unset", "-C", "--chdir", "-S", "--split-string"},
        )
        return _simple_starts_scheduler_job(nested, depth + 1)

    if executable in {"sudo", "doas", "runuser"}:
        nested = _skip_wrapper_options(
            tail,
            value_options={
                "-u", "--user", "-g", "--group", "-h", "--host",
                "-p", "--prompt", "-C", "--close-from", "-T",
                "--command-timeout", "-R", "--chroot", "-D", "--chdir",
                "-r", "--role", "-t", "--type", "-U", "--other-user",
            },
        )
        return _simple_starts_scheduler_job(nested, depth + 1)

    if executable == "su":
        for index, token in enumerate(tail):
            if token in {"-c", "--command"} and index + 1 < len(tail):
                return _command_starts_scheduler_job(tail[index + 1], depth + 1)
        return False

    if executable == "command":
        # ``command -v sbatch`` and ``command -V sbatch`` are diagnostics, not
        # execution.  Other command wrappers execute their remaining argv.
        if any(token in {"-v", "-V"} for token in tail):
            return False
        return _simple_starts_scheduler_job(_skip_wrapper_options(tail), depth + 1)

    if executable == "timeout":
        nested = _skip_wrapper_options(
            tail,
            value_options={"-k", "--kill-after", "-s", "--signal"},
        )
        # timeout's first positional argument is always DURATION.
        return _simple_starts_scheduler_job(nested[1:], depth + 1) if nested else False

    wrapper_value_options = {
        "nice": {"-n", "--adjustment"},
        "stdbuf": {"-i", "--input", "-o", "--output", "-e", "--error"},
        "time": {"-f", "--format", "-o", "--output"},
        "setsid": set(),
        "nohup": set(),
        "exec": set(),
    }
    if executable in wrapper_value_options:
        nested = _skip_wrapper_options(
            tail,
            value_options=wrapper_value_options[executable],
        )
        return _simple_starts_scheduler_job(nested, depth + 1)

    if executable == "eval":
        return _command_starts_scheduler_job(" ".join(tail), depth + 1)

    if executable == "ssh":
        # Locate the host after ssh options, then parse the remote command.  Do
        # not merely search for a token: ``ssh host grep sbatch log`` is benign.
        ssh_tail = _skip_wrapper_options(
            tail,
            value_options={
                "-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i",
                "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R",
                "-S", "-W", "-w",
            },
        )
        if len(ssh_tail) < 2:
            return False
        return _command_starts_scheduler_job(" ".join(ssh_tail[1:]), depth + 1)

    command_wrapper_value_options = {
        "xargs": {
            "-a", "--arg-file", "-d", "--delimiter", "-E", "--eof",
            "-I", "--replace", "-L", "--max-lines", "-n", "--max-args",
            "-P", "--max-procs", "-s", "--max-chars",
        },
        "parallel": {
            "-j", "--jobs", "-S", "--sshlogin", "--delay", "--timeout",
        },
        "watch": {"-n", "--interval"},
    }
    if executable in command_wrapper_value_options:
        nested = _skip_wrapper_options(
            tail,
            value_options=command_wrapper_value_options[executable],
        )
        return _simple_starts_scheduler_job(nested, depth + 1)
    return False


def _command_starts_scheduler_job(command, depth=0):
    """Conservatively recognize scheduler submission in shell command text."""
    return any(
        _simple_starts_scheduler_job(simple, depth)
        for simple in _simple_commands(_shell_tokens(command))
    )


def _terminal_starts_scheduler_job(args):
    """True for terminal requests that execute a scheduler submission.

    ``send_keys`` only executes text when Enter is present.  Keystrokes used to
    answer an interactive prompt (``y<enter>``) remain unguarded unless the same
    request contains a submit command.
    """
    action = str((args or {}).get("action", "")).lower()
    if action == "run":
        return _command_starts_scheduler_job((args or {}).get("command", ""))
    if action == "send_keys":
        keys = str((args or {}).get("keys", ""))
        if not _SEND_KEYS_ENTER_RE.search(keys):
            return False
        command = _SEND_KEYS_ENTER_RE.sub("\n", keys)
        return _command_starts_scheduler_job(command)
    return False

# numeric-producing tool families — matched by PREFIX so this covers BOTH server
# variants: the merged variant (catgo_analyze / catgo_catalysis) AND the 61-tool
# variant's fine-grained names (catgo_dos_*, catgo_catalysis_*, catgo_cohp_*,
# catgo_bands_*, catgo_energy, catgo_freq_*, ...). Exact-name matching left the
# fine-grained variant unguarded (enforcement never fired there).
_NUMERIC_PREFIXES = (
    "catgo_analyze", "catgo_catalysis", "catgo_dos", "catgo_cohp", "catgo_band",
    "catgo_bands", "catgo_energy", "catgo_freq", "catgo_bader", "catgo_gibbs",
    "catgo_thermo", "catgo_overpot", "catgo_charge",
    # fine-grained variant families that also produce physics numbers: KMC rates,
    # MD trajectory analysis, local ASE optimization (energy/forces)
    "catgo_kmc", "catgo_md_", "catgo_optimize", "catgo_cn_coupling",
)
_NUMERIC_EXEMPT_PREFIXES = ("hub_",)  # plugin-hub admin actions produce no physics
# actions of a numeric-family tool that emit geometry/inputs/guidance, not physics numbers —
# arming these poisons the session with a result nothing can verify (site lists,
# generated INCARs, and space groups have no gate and never will)
_NUMERIC_EXEMPT_ACTIONS = {"adsorption_sites", "dft_input", "dos", "symmetry"}

MIN_JUSTIFICATION = 20  # chars; an override has to say something, not just "ok"
# Sentinel "gate" for the case where NO gate could run (the result carries no
# checkable field). Measured on the independent corpus: 3/79 good results and
# 6/40 bad ones. Without an escape hatch those sessions are blocked forever —
# nothing failed, so there is nothing to fix and nothing to waive. The escape is
# deliberately the same narrow, justified, one-shot, audited path as a FAIL waiver.
NO_COVERAGE = "no-coverage"

_sessions = {}
_RESULT_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def _st(session_key="default"):
    """Session state.

    unverified  — count of numeric results produced since the last clean verify
    failed      — gate/claim names a verify actually FAILED on (empty = nothing known bad)
    override    — one-shot human-authored waiver: {"gates": [...], "why": str}
    audit       — append-only record of overrides that were spent (for the paper + forensics)
    """
    return _sessions.setdefault(session_key, {
        "unverified": 0,
        "in_flight": 0,
        "legacy_unverified": 0,
        "pending_digests": {},
        "identity_digests": {},
        "identity_history": {},
        "last_numeric": None,
        "failed": [],
        "failed_taxa": [],
        "legacy_failed": [],
        "legacy_failed_taxa": [],
        "failed_by_digest": {},
        "override": None,
        "approval_challenges": {},
        "used_approval_ids": [],
        "audit": [],
    })


def approval_secret_path():
    """Path shared only by the local backend and trusted desktop bridge."""
    configured = os.environ.get(_APPROVAL_SECRET_ENV, "").strip()
    return Path(configured).expanduser() if configured else (
        Path.home() / ".catgo" / "verification-approval.key"
    )


def approval_secret():
    """Read or atomically create the bridge/backend capability secret.

    The secret is deliberately outside MCP state and never appears in a tool
    response.  Failure to create/read/validate it raises, so approval remains
    fail-closed.
    """
    path = approval_secret_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        try:
            os.write(fd, (secrets.token_hex(32) + "\n").encode("ascii"))
        finally:
            os.close(fd)
    value = path.read_text(encoding="ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise RuntimeError("invalid CatGo verification approval secret")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return value


def verify_approval_secret(candidate):
    """Constant-time verification for the trusted approval endpoint."""
    if not isinstance(candidate, str) or not candidate:
        return False
    try:
        expected = approval_secret()
    except (OSError, RuntimeError, UnicodeError):
        return False
    return hmac.compare_digest(candidate, expected)


def _call_fingerprint(tool, args):
    clean = {k: v for k, v in (args or {}).items() if k != APPROVAL_ARG}
    try:
        encoded = json.dumps(
            {"tool": tool, "arguments": clean}, sort_keys=True,
            separators=(",", ":"), ensure_ascii=False, allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError):
        # MCP arguments are JSON, but fail closed if an in-process caller breaks
        # that contract rather than accidentally approving a different call.
        encoded = repr((tool, clean)).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _prune_challenges(st, now=None):
    now = time.time() if now is None else now
    for approval_id, challenge in list(st["approval_challenges"].items()):
        if challenge["expires_at"] <= now:
            st["approval_challenges"].pop(approval_id, None)


def _override_binding(override):
    return (
        sorted(override.get("result_digests", ())),
        int(override.get("legacy_unverified", 0)),
    )


def _remaining_unverified(st, override):
    bound_digests, bound_legacy = _override_binding(override)
    digest_count = len(set(st["pending_digests"]) - set(bound_digests))
    legacy_count = max(0, st["legacy_unverified"] - bound_legacy)
    return digest_count + legacy_count


def _challenge(st, tool, args, gates):
    now = time.time()
    _prune_challenges(st, now)
    fingerprint = _call_fingerprint(tool, args)
    normalized_gates = sorted(set(gates))
    result_digests, legacy_unverified = _override_binding(st["override"])
    for challenge in st["approval_challenges"].values():
        if (challenge["fingerprint"] == fingerprint
                and challenge["gates"] == normalized_gates
                and challenge["result_digests"] == result_digests
                and challenge["legacy_unverified"] == legacy_unverified
                and challenge["approved_at"] is None):
            return challenge
    approval_id = secrets.token_urlsafe(24)
    challenge = {
        "approval_id": approval_id,
        "fingerprint": fingerprint,
        "tool": tool,
        "action": (args or {}).get("action"),
        "gates": normalized_gates,
        "result_digests": result_digests,
        "legacy_unverified": legacy_unverified,
        "created_at": now,
        "expires_at": now + APPROVAL_TTL_SECONDS,
        "approved_at": None,
        "approved_by": None,
    }
    st["approval_challenges"][approval_id] = challenge
    return challenge


def approve_override(approval_id, session_key="default", approved_by="human"):
    """Approve one live challenge after the HTTP layer authenticates the caller."""
    st = _st(session_key)
    _prune_challenges(st)
    challenge = st["approval_challenges"].get(str(approval_id or ""))
    if challenge is None:
        raise ValueError("unknown or expired approval challenge")
    if challenge["approved_at"] is not None:
        raise ValueError("approval challenge was already approved")
    ov = st.get("override")
    if (not ov or not set(challenge["gates"]) <= set(ov["gates"])
            or (challenge["result_digests"], challenge["legacy_unverified"])
            != _override_binding(ov)):
        raise ValueError("the underlying override is no longer valid")
    challenge["approved_at"] = time.time()
    challenge["approved_by"] = str(approved_by or "human")
    return copy.deepcopy(challenge)


def _approved_override(st, tool, args, gates):
    """Consume a human-approved exact-call challenge, or issue a prompt."""
    _prune_challenges(st)
    approval_id = str((args or {}).get(APPROVAL_ARG, "") or "")
    fingerprint = _call_fingerprint(tool, args)
    normalized_gates = sorted(set(gates))
    ov = st["override"]
    result_digests, legacy_unverified = _override_binding(ov)
    challenge = st["approval_challenges"].get(approval_id) if approval_id else None
    if (challenge and challenge["approved_at"] is not None
            and challenge["fingerprint"] == fingerprint
            and challenge["gates"] == normalized_gates
            and challenge["result_digests"] == result_digests
            and challenge["legacy_unverified"] == legacy_unverified):
        remaining = _remaining_unverified(st, ov)
        if remaining:
            return (
                FORBIDDEN,
                f"BLOCKED: human approval covers only result digest(s) "
                f"{', '.join(result_digests) or 'the bound legacy result'}; "
                f"{remaining} other numeric result(s) remain unverified.",
            )
        st["approval_challenges"].pop(approval_id, None)
        st["used_approval_ids"].append(approval_id)
        st["used_approval_ids"] = st["used_approval_ids"][-100:]
        st["override"] = None
        st["audit"].append({
            "waived": normalized_gates,
            "why": ov["why"],
            "tool": tool,
            "action": (args or {}).get("action"),
            "approval_id": approval_id,
            "approved_at": challenge["approved_at"],
            "approved_by": challenge["approved_by"],
            "result_digests": result_digests,
            "legacy_unverified": legacy_unverified,
        })
        return (ALLOW,
                f"⚠ HUMAN-APPROVED OVERRIDE: proceeding despite "
                f"{', '.join(normalized_gates)} — justification: {ov['why']}")
    if approval_id:
        return (PROMPT,
                "HUMAN APPROVAL REQUIRED: the supplied approval challenge is "
                "invalid, expired, not approved, or does not match this exact call.")
    challenge = _challenge(st, tool, args, normalized_gates)
    return (PROMPT,
            "HUMAN APPROVAL REQUIRED: this one-shot verification override must "
            "be approved in CatGo before dispatch. Retry the exact same tool call "
            f"with {APPROVAL_ARG}='{challenge['approval_id']}'.")


def _valid_digest(value):
    return isinstance(value, str) and bool(_RESULT_DIGEST_RE.fullmatch(value))


def _refresh(st):
    """Project digest-scoped bookkeeping onto the legacy aggregate interface."""
    st["unverified"] = (st["legacy_unverified"] + len(st["pending_digests"])
                        + st.get("in_flight", 0))
    failed = set(st["legacy_failed"])
    taxa = set(st["legacy_failed_taxa"])
    for record in st["failed_by_digest"].values():
        failed.update(record.get("gates", ()))
        taxa.update(record.get("taxa", ()))
    st["failed"] = sorted(failed)
    st["failed_taxa"] = sorted(taxa)


def _is_submit(tool, args):
    if tool not in IRREVERSIBLE:
        return False
    action = str((args or {}).get("action", "")).lower()
    # Only submit-like actions spend budget — for BOTH workflow tools. The engine's
    # status / list / get_result / get_dag / pause / create / add_task / modify_params /
    # reset are read-only or workspace-write; blanket-treating the engine as a submit
    # blocked exactly the diagnostic actions an agent needs while results are pending.
    return action in _IRREVERSIBLE_ACTIONS


def _is_guarded_release(tool, args):
    action = str((args or {}).get("action", "")).lower()
    return (
        _is_submit(tool, args)
        or (tool, action) in _RESULT_RELEASE_ACTIONS
        or (tool == "catgo_terminal" and _terminal_starts_scheduler_job(args))
    )


def _is_numeric(tool, args):
    if (args or {}).get("_numeric_response"):
        return True
    if tool == "catgo_workflow":
        return str((args or {}).get("action", "")).lower() == "batch_results"
    if tool == "catgo_workflow_engine":
        # get_result returns the node's actual numbers. Leaving it unarmed let an
        # agent read a result and submit the next HPC job without verifying it —
        # the exact bypass this layer exists to close. `status` carries progress,
        # not results, and stays exempt so diagnosis is still free.
        return str((args or {}).get("action", "")).lower() == "get_result"
    if not tool.startswith(_NUMERIC_PREFIXES):
        return False
    action = str((args or {}).get("action", ""))
    if action in _NUMERIC_EXEMPT_ACTIONS:
        return False
    return not action.startswith(_NUMERIC_EXEMPT_PREFIXES)


def _may_produce_numeric(tool, args):
    """True before dispatch when only the response can prove it is numeric."""
    if _is_numeric(tool, args):
        return True
    return (
        tool == "catgo_workflow"
        and str((args or {}).get("action", "")).lower()
        in {"status", "results", "step_error"}
    )


def precheck(tool, args, session_key="default"):
    """Call BEFORE dispatching a tool. Returns (decision, reason).

    Two distinct FORBIDDEN reasons, in strictest-first order:
      1. verify FAILED (or refused to certify a claim) and nothing was fixed
         → the result is *known* bad; submitting is worse than not having checked.
      2. numeric results exist that were never verified at all.
    A one-shot override first returns PROMPT and cannot dispatch until a trusted
    host records explicit human approval for the exact call.
    """
    st = _st(session_key)
    if not _is_guarded_release(tool, args):
        return (ALLOW, "")

    if st.get("in_flight", 0) > 0:
        return (
            FORBIDDEN,
            f"BLOCKED: {st['in_flight']} numeric tool call(s) are still running "
            f"({st['last_numeric']}). Wait for them to finish and verify their "
            f"results before submitting.",
        )

    if st["failed"]:
        ov = st["override"]
        if ov and set(st["failed"]) <= set(ov["gates"]):
            return _approved_override(st, tool, args, st["failed"])
        return (FORBIDDEN,
                f"BLOCKED: catgo_verify FAILED on {', '.join(sorted(st['failed']))} "
                f"[silent-error taxa {', '.join(st['failed_taxa']) or 'n/a'}]. "
                f"A result known to be wrong must not spend HPC budget. Fix the "
                f"result and re-run catgo_verify (a clean audit clears this), or — "
                f"if this is a false alarm — call catgo_verify with "
                f"override=[<gate names>] and justification='<why, ≥"
                f"{MIN_JUSTIFICATION} chars>' to record a waiver.")

    if st["unverified"] > 0:
        ov = st["override"]
        if ov and NO_COVERAGE in ov["gates"]:
            return _approved_override(st, tool, args, [NO_COVERAGE])
        return (FORBIDDEN,
                f"BLOCKED: {st['unverified']} numeric result(s) from "
                f"{st['last_numeric']} have not passed catgo_verify. Run "
                f"catgo_verify on the parsed result (with claims=[...]) before "
                f"submitting — an unverified number must not spend HPC budget. "
                f"If no gate can check this result at all, call catgo_verify with "
                f"override=['{NO_COVERAGE}'] and justification='<why it is sound "
                f"anyway>' to record a waiver.")
    return (ALLOW, "")


def arm_pending(tool, session_key="default"):
    """Mark a numeric call as in-flight BEFORE it is dispatched.

    postmark runs after dispatch, which for an HPC-backed tool is seconds. A
    concurrent submit arriving inside that window saw a clean session and went
    through — the result it should have waited for was still being computed.
    The in-flight count blocks releases the same way a produced result does; it
    is cleared only by finish_pending() in the shared wrapper's finally block,
    so failures and cancellation cannot wedge the session and an unrelated
    postmark cannot retire somebody else's call.
    """
    st = _st(session_key)
    st["in_flight"] = st.get("in_flight", 0) + 1
    st["last_numeric"] = tool
    _refresh(st)


def finish_pending(session_key="default"):
    """Retire one pre-dispatch marker, including cancellation/error paths."""
    st = _st(session_key)
    if st.get("in_flight", 0) > 0:
        st["in_flight"] -= 1
    _refresh(st)


def drop_session(session_key="default"):
    """Discard an MCP session ledger after its transport is reclaimed."""
    _sessions.pop(str(session_key), None)


def postmark(tool, args, ok=True, session_key="default"):
    """Call AFTER a tool ran. Tracks pending-verification state.

    NOTE: catgo_verify does NOT clear state here — clearing is done by the handler
    via mark_verified() ONLY when the audit actually ran a gate, so an EMPTY
    catgo_verify (a result with no verifiable fields → all gates SKIP) cannot wipe
    the pending state and bypass enforcement.
    """
    st = _st(session_key)
    if not ok:
        _refresh(st)
        return
    if _is_numeric(tool, args):
        records = []
        for record in (args or {}).get("_result_records", ()):
            if not isinstance(record, dict):
                continue
            digest = record.get("digest")
            identity = record.get("identity")
            if _valid_digest(digest):
                records.append({
                    "digest": digest,
                    "identity": identity if _valid_digest(identity) else None,
                })
        digests = {
            digest for digest in (args or {}).get("_result_digests", ())
            if _valid_digest(digest)
        }
        digests.update(record["digest"] for record in records)
        if records:
            for record in records:
                digest = record["digest"]
                identity = record["identity"]
                if identity:
                    old_digest = st["identity_digests"].get(identity)
                    history = st["identity_history"].setdefault(identity, [])
                    if old_digest and old_digest != digest:
                        st["pending_digests"].pop(old_digest, None)
                        st["failed_by_digest"].pop(old_digest, None)
                        st["audit"].append({
                            "event": "result_superseded",
                            "identity": identity,
                            "old_digest": old_digest,
                            "new_digest": digest,
                            "tool": tool,
                        })
                    st["identity_digests"][identity] = digest
                    if digest not in history:
                        history.append(digest)
                st["pending_digests"][digest] = tool
            for digest in digests - {record["digest"] for record in records}:
                st["pending_digests"][digest] = tool
        elif digests:
            for digest in digests:
                st["pending_digests"][digest] = tool
        else:
            st["legacy_unverified"] += 1
        st["last_numeric"] = tool
        _refresh(st)


def mark_verified(covered, failed_gates=(), failed_taxa=(), uncertified_claims=(),
                  result_digest=None, session_key="default"):
    """Called by the catgo_verify handler after an audit.

    Clearing requires BOTH conditions — this is the fix for a real bypass found by
    driving the live MCP server: previously any verify that merely *ran* a gate
    cleared the pending state, so an agent could call catgo_verify, be told
    "FAIL — do NOT report this result as correct", and submit the job anyway.

      covered (coverage.ran > 0)  — an empty/all-SKIP verify is not a clean bill
      no FAIL and no uncertified claim — a known-bad result stays blocked

    A later clean verify on the fixed result clears both flags.
    """
    st = _st(session_key)
    bad = sorted(set(failed_gates) | {f"claim:{c}" for c in uncertified_claims})
    if not covered and not bad:
        return
    # A refused claim counts even when NO value gate could run — that is exactly the
    # case the verifiability layer exists for (nothing checkable, provenance absent),
    # and dropping it here let the agent see only the vaguer "unverified" message.
    if bad:
        if _valid_digest(result_digest):
            st["failed_by_digest"][result_digest] = {
                "gates": bad,
                "taxa": sorted(set(failed_taxa)),
            }
        else:
            st["legacy_failed"] = bad
            st["legacy_failed_taxa"] = sorted(set(failed_taxa))
        st["override"] = None  # a new failing audit invalidates a stale waiver
        st["approval_challenges"].clear()
        _refresh(st)
        return
    if _valid_digest(result_digest):
        st["pending_digests"].pop(result_digest, None)
        st["failed_by_digest"].pop(result_digest, None)
    else:
        # A bare verification cannot identify which legacy PRODUCED result it
        # checked. Clearing the produced-count here let "verify one, release all"
        # bypass the gate. Successful numeric dispatch now envelopes scalar/prose
        # payloads too; any remaining legacy producer must be fixed or waived.
        if st["legacy_unverified"]:
            st["audit"].append({
                "event": "unbound_verification_ignored",
                "legacy_pending": st["legacy_unverified"],
            })
    # legacy_failed is identity-less by construction (set by a bare FAILing
    # verify), so a clean covered audit is the only clear it can ever have. The
    # FORBIDDEN message promises "a clean audit clears this"; without this the
    # bare fix-and-reverify loop dead-ends with override as the only exit
    # (found by live_mcp_probe scenario provenance_loop).
    st["legacy_failed"] = []
    st["legacy_failed_taxa"] = []
    st["override"] = None
    st["approval_challenges"].clear()
    _refresh(st)


def register_override(gates, justification, session_key="default"):
    """Record a one-shot human-authored waiver for gates that actually FAILED.

    Deliberately narrow: you may only waive what is currently failing, you must
    name each gate, and you must say why. Raises ValueError otherwise — a waiver
    that can be issued reflexively is not a waiver, it is an off switch.
    """
    st = _st(session_key)
    gates = [g for g in (gates or []) if str(g).strip()]
    if not gates:
        raise ValueError("override requires the gate name(s) being waived")
    waivable = set(st["failed"])
    if not st["failed"] and st["unverified"] > 0:
        waivable = {NO_COVERAGE}  # nothing failed, nothing checkable → the escape hatch
    if not waivable:
        raise ValueError("nothing to override — no gate is currently failing and "
                         "no result is pending verification")
    unknown = sorted(set(gates) - waivable)
    if unknown:
        raise ValueError(f"cannot override gate(s) that did not fail: {unknown} "
                         f"(waivable now: {sorted(waivable)})")
    why = (justification or "").strip()
    if len(why) < MIN_JUSTIFICATION:
        raise ValueError(f"justification must be ≥{MIN_JUSTIFICATION} chars saying why "
                         f"this FAIL is a false alarm (got {len(why)})")
    selected_gates = set(gates)
    if st["failed"]:
        result_digests = sorted(
            digest for digest, record in st["failed_by_digest"].items()
            if set(record.get("gates", ())) <= selected_gates
        )
        # Legacy results have no stable identity. Bind at most the one result
        # represented by the failing bare audit; any additional legacy result
        # remains pending and therefore blocks release.
        legacy_unverified = 1 if st["legacy_failed"] and st["legacy_unverified"] else 0
    else:
        # NO_COVERAGE applies to the exact pending digest snapshot. A numeric
        # result produced later is outside the waiver and remains blocking.
        result_digests = sorted(st["pending_digests"])
        legacy_unverified = min(st["legacy_unverified"], 1)
    st["override"] = {
        "gates": sorted(selected_gates),
        "why": why,
        "result_digests": result_digests,
        "legacy_unverified": legacy_unverified,
    }
    st["approval_challenges"].clear()
    return st["override"]


def state(session_key="default"):
    """Read-only snapshot (for tests, telemetry, and the paper's audit counts)."""
    st = _st(session_key)
    return copy.deepcopy(st)


if __name__ == "__main__":
    # strictest-wins
    assert strictest(ALLOW, PROMPT) == PROMPT and strictest(PROMPT, FORBIDDEN) == FORBIDDEN

    sk = "t1"
    d1 = "sha256:" + "1" * 64
    # clean session: submit is allowed (approval layer handles the human PROMPT)
    assert precheck("catgo_workflow", {"action": "submit"}, sk)[0] == ALLOW
    # numeric result produced -> submit becomes FORBIDDEN until verified
    postmark("catgo_analyze", {
        "action": "thermo_free_energy", "_result_digests": [d1],
    }, ok=True, session_key=sk)
    dec, reason = precheck("catgo_workflow", {"action": "submit"}, sk)
    assert dec == FORBIDDEN and "catgo_verify" in reason
    # non-submit actions of the same tool stay allowed
    assert precheck("catgo_workflow", {"action": "status"}, sk)[0] == ALLOW
    # hub admin actions are not "numeric"
    postmark("catgo_analyze", {"action": "hub_search"}, ok=True, session_key="t2")
    assert precheck("catgo_workflow_engine", {}, "t2")[0] == ALLOW
    # a clean verify (a gate ran, nothing failed) clears the pending state.
    # NB: postmark("catgo_verify") does NOT clear — only the handler's
    # mark_verified() does, so an agent cannot clear by *calling* the tool.
    postmark("catgo_verify", {}, ok=True, session_key=sk)
    assert precheck("catgo_workflow", {"action": "submit"}, sk)[0] == FORBIDDEN
    mark_verified(True, result_digest=d1, session_key=sk)
    assert precheck("catgo_workflow", {"action": "submit"}, sk)[0] == ALLOW
    # failed tool runs do not count as produced results
    postmark("catgo_analyze", {"action": "dos"}, ok=False, session_key="t3")
    assert precheck("catgo_workflow_engine", {"action": "submit"}, "t3")[0] == ALLOW

    # --- a bare FAIL then a clean bare re-verify clears the failure (no dead end);
    # the produced-result pending stays strict ---
    skb = "t-bare"
    postmark("catgo_analyze", {"action": "rdf"}, ok=True, session_key=skb)  # no records → legacy
    mark_verified(True, failed_gates=["physical_range"], failed_taxa=["A2"], session_key=skb)
    assert precheck("catgo_workflow", {"action": "submit"}, skb)[0] == FORBIDDEN
    mark_verified(True, session_key=skb)          # fixed + clean, still unbound
    assert state(skb)["failed"] == []             # failure cleared — message kept its promise
    assert precheck("catgo_workflow", {"action": "submit"}, skb)[0] == FORBIDDEN  # legacy pending stays

    # --- engine read/control actions stay usable while results are pending ---
    ske = "t-engine"
    postmark("catgo_kmc_simulate", {}, ok=True, session_key=ske)   # fine-grained numeric arms
    for benign in ("status", "list", "get_result", "get_dag", "pause"):
        assert precheck("catgo_workflow_engine", {"action": benign}, ske)[0] == ALLOW, benign
    assert precheck("catgo_workflow_engine", {"action": "submit"}, ske)[0] == FORBIDDEN
    # md/optimize families arm too; geometry-only actions do not
    assert _is_numeric("catgo_md_rdf", {}) and _is_numeric("catgo_optimize", {})
    for exempt in ("adsorption_sites", "dft_input", "symmetry"):
        assert not _is_numeric("catgo_analyze", {"action": exempt}), exempt

    # --- a FAILING verify must NOT clear the gate (the live-probe bypass) ---
    sk2 = "t4"
    d2 = "sha256:" + "2" * 64
    postmark("catgo_analyze", {
        "action": "thermo_free_energy", "_result_digests": [d2],
    }, ok=True, session_key=sk2)
    mark_verified(True, failed_gates=["ul_range"], failed_taxa=["G2"],
                  result_digest=d2, session_key=sk2)
    dec, why = precheck("catgo_workflow", {"action": "submit"}, sk2)
    assert dec == FORBIDDEN and "ul_range" in why
    # an uncertified claim blocks too, even with every value gate passing
    sk3 = "t5"
    d3 = "sha256:" + "3" * 64
    postmark("catgo_analyze", {
        "action": "thermo_free_energy", "_result_digests": [d3],
    }, ok=True, session_key=sk3)
    mark_verified(True, uncertified_claims=["binding_dG"],
                  result_digest=d3, session_key=sk3)
    assert precheck("catgo_workflow", {"action": "submit"}, sk3)[0] == FORBIDDEN
    # fixing the result and re-verifying clean clears it
    mark_verified(True, result_digest=d3, session_key=sk3)
    assert precheck("catgo_workflow", {"action": "submit"}, sk3)[0] == ALLOW

    # --- override: narrow, justified, one-shot ---
    for bad in ([], ["physical_range"]):          # empty / not-actually-failing
        try:
            register_override(bad, "x" * 40, session_key=sk2); raise SystemExit("no raise")
        except ValueError:
            pass
    try:                                          # justification too short
        register_override(["ul_range"], "ok", session_key=sk2); raise SystemExit("no raise")
    except ValueError:
        pass
    register_override(["ul_range"], "cer U_L window is reaction-dependent; "
                                    "geometry checked in D-06", session_key=sk2)
    dec, why = precheck("catgo_workflow", {"action": "submit"}, sk2)
    assert dec == PROMPT and "HUMAN APPROVAL REQUIRED" in why
    approval_id = next(iter(state(sk2)["approval_challenges"]))
    approve_override(approval_id, session_key=sk2, approved_by="self-test")
    dec, why = precheck(
        "catgo_workflow", {"action": "submit", APPROVAL_ARG: approval_id}, sk2,
    )
    assert dec == ALLOW and "HUMAN-APPROVED" in why
    assert len(state(sk2)["audit"]) == 1
    # one-shot: the next submit is blocked again
    assert precheck("catgo_workflow", {"action": "submit"}, sk2)[0] == FORBIDDEN
    # a fresh failing audit invalidates a stale waiver
    register_override(["ul_range"], "same waiver as above, still a false alarm",
                      session_key=sk2)
    mark_verified(True, failed_gates=["ul_range"], failed_taxa=["G2"],
                  result_digest=d2, session_key=sk2)
    assert precheck("catgo_workflow", {"action": "submit"}, sk2)[0] == FORBIDDEN

    print("verify_enforcement self-test OK — tri-state strictest-wins; unverified "
          "numerics FORBID irreversible submits; a FAILED or uncertified verify keeps "
          "them forbidden; only a clean audit clears; override is narrow, justified, "
          "one-shot and audited; hub/admin and failed runs exempt")
