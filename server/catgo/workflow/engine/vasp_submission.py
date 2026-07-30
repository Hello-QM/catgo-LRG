"""Shared VASP command resolution and remote input preflight."""

from __future__ import annotations

from dataclasses import dataclass
import json
import posixpath
import re
import logging
import shlex
from typing import Any


VASP_FALLBACK_COMMAND = "srun vasp_std"
VASP_INPUT_MANIFEST = "catgo_vasp_input_manifest.json"
logger = logging.getLogger(__name__)

VASP_MANDATORY_INPUTS = ("INCAR", "POSCAR", "POTCAR", "KPOINTS")


@dataclass(frozen=True)
class VaspCommandResolution:
    command: str
    binary_token: str | None
    source: str


def _nonempty(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _shell_command_segments(command: str) -> list[list[str]]:
    """Split shell text into executable segments, excluding redirection targets."""
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>")
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:
        tokens = command.split()

    segments: list[list[str]] = [[]]
    skip_redirect_target = False
    for token in tokens:
        if skip_redirect_target:
            skip_redirect_target = False
            continue
        if token in {"&&", "||", ";", "|"}:
            if segments[-1]:
                segments.append([])
            continue
        if "<" in token or ">" in token:
            if segments[-1] and segments[-1][-1].isdigit():
                segments[-1].pop()
            skip_redirect_target = True
            continue
        segments[-1].append(token)
    return [segment for segment in segments if segment]


def _validate_vasp_command(command: str) -> None:
    """Reject shell composition that can skip, duplicate, or mask VASP."""
    if "\n" in command or "\r" in command:
        raise ValueError("VASP command must be one physical shell line")
    if "$(" in command or "`" in command:
        raise ValueError("VASP command substitution is not auditable")
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>")
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError as exc:
        raise ValueError(f"VASP command is not valid shell text: {exc}") from exc
    operators = [token for token in tokens if token in {"&&", "||", ";", "|", "&"}]
    if operators:
        raise ValueError(
            "VASP command shell control operator is not auditable: "
            + ", ".join(operators)
        )


def _extract_vasp_binary_token(command: str) -> str | None:
    """Parse a declared executable token; return None rather than guess."""
    segments = _shell_command_segments(command)

    # Support renamed binaries after the common MPI/SLURM launchers.
    launchers = {"srun", "mpirun", "mpiexec", "aprun"}
    options_with_value = {
        "-A", "-N", "-c", "-n", "-np", "-p", "-t", "-x",
        "--account", "--bind-to", "--chdir", "--cpu-bind", "--cpus-per-task",
        "--export", "--hint", "--host", "--hostfile", "--map-by", "--mpi",
        "--nodes", "--ntasks", "--partition", "--time",
    }
    options_without_value = {
        "--exclusive", "--label", "--overlap", "--oversubscribe", "--unbuffered",
    }
    for segment in reversed(segments):
        start = 0
        while start < len(segment) and (
            segment[start] in {"env", "time"} or "=" in segment[start]
        ):
            start += 1
        if start >= len(segment):
            continue

        first = segment[start].rstrip(";")
        if posixpath.basename(first) not in launchers:
            if "vasp" in posixpath.basename(first).lower():
                return first
            continue

        index = start + 1
        while index < len(segment):
            candidate = segment[index]
            if candidate in options_with_value:
                if index + 1 >= len(segment):
                    return None
                index += 2
                continue
            if candidate in options_without_value or (
                candidate.startswith("--") and "=" in candidate
            ):
                index += 1
                continue
            if candidate.startswith("-") or candidate.isdigit():
                return None
            return candidate.rstrip(";")
        return None
    return None


def resolve_vasp_use_custodian(params: dict, config: dict) -> bool:
    hpc_cfg = config.get("hpc", {}) or {}
    return bool(params.get("use_custodian", hpc_cfg.get("use_custodian", False)))


def validate_vasp_job_script(
    job_script: str,
    resolution: VaspCommandResolution,
    use_custodian: bool,
) -> None:
    """Require one auditable VASP execution path and reject shell indirection."""
    expected = (
        "python run_custodian.py" if use_custodian else resolution.command
    ).strip()
    _validate_vasp_command(resolution.command)
    lines = [
        line.strip() for line in job_script.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if lines.count(expected) != 1:
        raise ValueError(
            "VASP job script must contain the resolved execution command as "
            f"one exact standalone line: {expected!r}"
        )
    control = re.compile(
        r"^(if|then|else|elif|fi|for|while|until|case|esac|select|function)\b"
    )
    for line in lines:
        if ("$(" in line or "`" in line) and not line.startswith("echo "):
            # The ban makes the EXECUTION path auditable. An `echo` line cannot
            # become one — and the repo ships a Shaheen3 template ending in
            # `echo "Calculation finished on $(date)."`, which a blanket ban
            # rejects, so generate_job_script() failed on CatGo's own template.
            raise ValueError("VASP job script command substitution is not auditable")
        if control.match(line) or line in {"{", "}"}:
            raise ValueError(
                "VASP job script control flow is not auditable; use a linear "
                "setup followed by the resolved execution command"
            )
        if line == expected:
            continue
        candidate = _extract_vasp_binary_token(line)
        if candidate or "run_custodian.py" in line:
            raise ValueError(
                "VASP job script contains an execution path that differs from "
                f"the manifest: {line!r}"
            )
        allowed_setup = (
            "module ", "ml ", "export ", "unset ", "source ", ". ", "cd ",
            "set ", "ulimit ", "conda activate ",
            # `echo` is a log line, not an execution path. Omitting it rejected
            # CatGo's own Shaheen3 template, whose last line is
            # `echo "Calculation finished on $(date)."`.
            "echo ",
        )
        if not line.startswith(allowed_setup) and not re.fullmatch(
            r"[A-Za-z_][A-Za-z0-9_]*=.*", line
        ):
            raise ValueError(
                "VASP job script contains a non-auditable executable line: "
                f"{line!r}"
            )


def resolve_vasp_command(params: dict, config: dict) -> VaspCommandResolution:
    """Resolve VASP command once: params > job_defaults > run_commands > fallback."""
    hpc_cfg = config.get("hpc", {}) or {}
    job_defaults = hpc_cfg.get("job_defaults", {}) or {}
    run_commands = hpc_cfg.get("run_commands", {}) or {}

    candidates = (
        ("params.run_command", params.get("run_command")),
        ("params.vasp_command", params.get("vasp_command")),
        ("hpc.job_defaults.vasp_command", job_defaults.get("vasp_command")),
        ("hpc.job_defaults.run_command", job_defaults.get("run_command")),
        (
            "hpc.run_commands.vasp",
            run_commands.get("vasp") if isinstance(run_commands, dict) else "",
        ),
        ("fallback", VASP_FALLBACK_COMMAND),
    )
    source, command = next(
        (candidate_source, value)
        for candidate_source, raw in candidates
        if (value := _nonempty(raw))
    )
    _validate_vasp_command(command)

    binary_token = _extract_vasp_binary_token(command)
    executable_override = _nonempty(params.get("vasp_executable"))
    if executable_override and executable_override != "vasp_std":
        if binary_token:
            replacement = executable_override
            if "/" in binary_token and "/" not in executable_override:
                replacement = f"{binary_token.rsplit('/', 1)[0]}/{executable_override}"
            command = command.replace(binary_token, replacement, 1)
            binary_token = replacement
        else:
            try:
                direct = shlex.split(command)
            except ValueError:
                direct = []
            if direct == [executable_override]:
                binary_token = executable_override
    elif executable_override and binary_token is None:
        try:
            direct = shlex.split(command)
        except ValueError:
            direct = []
        if direct == [executable_override]:
            binary_token = executable_override

    _validate_vasp_command(command)

    return VaspCommandResolution(
        command=command,
        binary_token=binary_token,
        source=source,
    )


def _quote_remote_work_dir(work_dir: str) -> str:
    """Quote a remote path while preserving leading ``~/`` expansion."""
    if work_dir == "~":
        return '"$HOME"'
    if work_dir.startswith("~/"):
        return f'"$HOME"/{shlex.quote(work_dir[2:])}'
    return shlex.quote(work_dir)


def build_vasp_input_manifest_command(
    work_dir: str,
    resolution: VaspCommandResolution,
    use_custodian: bool = False,
) -> str:
    """Build a POSIX-shell preflight that writes JSON, then rejects missing inputs."""
    run_command_json = shlex.quote(json.dumps(resolution.command, ensure_ascii=True))
    binary_token_json = shlex.quote(json.dumps(resolution.binary_token, ensure_ascii=True))
    source_json = shlex.quote(json.dumps(resolution.source, ensure_ascii=True))
    binary_declared = "true" if resolution.binary_token is not None else "false"
    # Recorded diagnostically. It does not authorize hash divergence: until an
    # independent submit-time correction ledger exists, the collector records a
    # custodian-mode rewrite but deliberately leaves the result unverifiable.
    custodian_declared = "true" if use_custodian else "false"
    remote_dir = _quote_remote_work_dir(work_dir)

    return f"""cd {remote_dir} && /bin/sh <<'CATGO_VASP_PREFLIGHT'
catgo_manifest={shlex.quote(VASP_INPUT_MANIFEST)}
catgo_manifest_tmp=".${{catgo_manifest}}.tmp.$$"
catgo_run_command_json={run_command_json}
catgo_binary_token_json={binary_token_json}
catgo_command_source_json={source_json}
catgo_binary_declared={binary_declared}

catgo_sha256() {{
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{{print $1}}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{{print $1}}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" | sed 's/^.*= //'
    else
        return 1
    fi
}}

catgo_emit_input() {{
    catgo_name=$1
    # $2 = "true" when this input is optional for THIS job (KPOINTS under
    # KSPACING). The collector reads `mandatory` rather than assuming.
    if [ "$2" = true ]; then
        catgo_mandatory=false
    else
        catgo_mandatory=true
    fi
    if [ -f "$catgo_name" ]; then
        if catgo_hash=$(catgo_sha256 "$catgo_name" 2>/dev/null); then
            printf '{{"mandatory":%s,"exists":true,"sha256":"%s"}}' "$catgo_mandatory" "$catgo_hash"
        else
            printf '{{"mandatory":%s,"exists":true,"sha256":null}}' "$catgo_mandatory"
        fi
    else
        printf '{{"mandatory":%s,"exists":false,"sha256":null}}' "$catgo_mandatory"
    fi
}}

catgo_has_positive_kspacing() {{
    awk '
    {{
        line=$0
        sub(/[#!].*$/, "", line)
        upper=toupper(line)
        while (match(upper, /(^|[;[:space:]])KSPACING[[:space:]]*=/)) {{
            value=substr(line, RSTART + RLENGTH)
            sub(/^[[:space:]]*/, "", value)
            split(value, fields, /[;[:space:]]/)
            value=fields[1]
            gsub(/[Dd]/, "E", value)
            if (value ~ /^[-+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([Ee][-+]?[0-9]+)?$/ && value + 0 > 0) {{
                found=1
            }} else {{
                found=0
            }}
            offset=RSTART + RLENGTH
            line=substr(line, offset)
            upper=substr(upper, offset)
        }}
    }}
    END {{ exit(found ? 0 : 1) }}
    ' "$1"
}}

catgo_missing_json=
catgo_missing_text=
if command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || command -v openssl >/dev/null 2>&1; then
    catgo_hash_available=true
else
    catgo_hash_available=false
fi
# KPOINTS is mandatory only when INCAR does not set KSPACING: with KSPACING the
# mesh comes from the INCAR and VASP ignores (and does not need) a KPOINTS file.
# Demanding it unconditionally rejected perfectly valid jobs at submit time.
catgo_kspacing=false
if [ -f INCAR ] && catgo_has_positive_kspacing INCAR; then
    catgo_kspacing=true
fi
for catgo_name in {" ".join(VASP_MANDATORY_INPUTS)}; do
    if [ "$catgo_name" = KPOINTS ] && [ "$catgo_kspacing" = true ]; then
        continue
    fi
    if [ ! -f "$catgo_name" ]; then
        if [ -n "$catgo_missing_json" ]; then
            catgo_missing_json="$catgo_missing_json,"
        fi
        catgo_missing_json="$catgo_missing_json\\"$catgo_name\\""
        catgo_missing_text="$catgo_missing_text $catgo_name"
    fi
done
if [ -n "$catgo_missing_text" ] || [ "$catgo_binary_declared" != true ] || [ "$catgo_hash_available" != true ]; then
    catgo_ready=false
else
    catgo_ready=true
fi

{{
    printf '{{\\n'
    printf '  "schema_version": 1,\\n'
    printf '  "engine": "vasp",\\n'
    printf '  "resolved_run_command": %s,\\n' "$catgo_run_command_json"
    printf '  "binary": %s,\\n' "$catgo_binary_token_json"
    printf '  "binary_token": %s,\\n' "$catgo_binary_token_json"
    printf '  "binary_declared": %s,\\n' "$catgo_binary_declared"
    printf '  "hash_algorithm": "sha256",\\n'
    printf '  "hash_available": %s,\\n' "$catgo_hash_available"
    printf '  "command_source": %s,\\n' "$catgo_command_source_json"
    printf '  "use_custodian": %s,\\n' "{custodian_declared}"
    printf '  "inputs": {{\\n'
    printf '    "INCAR": '; catgo_emit_input INCAR; printf ',\\n'
    printf '    "POSCAR": '; catgo_emit_input POSCAR; printf ',\\n'
    printf '    "POTCAR": '; catgo_emit_input POTCAR; printf ',\\n'
    printf '    "KPOINTS": '; catgo_emit_input KPOINTS "$catgo_kspacing"; printf '\\n'
    printf '  }},\\n'
    printf '  "missing_mandatory_inputs": [%s],\\n' "$catgo_missing_json"
    printf '  "ready": %s\\n' "$catgo_ready"
    printf '}}\\n'
}} > "$catgo_manifest_tmp" || {{
    printf '%s\\n' "CatGo VASP preflight failed: could not write $catgo_manifest_tmp" >&2
    exit 73
}}
if ! mv "$catgo_manifest_tmp" "$catgo_manifest"; then
    printf '%s\\n' "CatGo VASP preflight failed: could not install $catgo_manifest" >&2
    exit 73
fi

if [ "$catgo_ready" != true ]; then
    if [ -n "$catgo_missing_text" ]; then
        printf '%s\\n' "CatGo VASP preflight failed: missing mandatory inputs:$catgo_missing_text (manifest: $catgo_manifest)" >&2
        exit 66
    fi
    if [ "$catgo_hash_available" != true ]; then
        printf '%s\\n' "CatGo VASP preflight failed: no SHA-256 implementation available (manifest: $catgo_manifest)" >&2
        exit 67
    fi
    printf '%s\\n' "CatGo VASP preflight failed: binary token is unknown; set params.vasp_executable (manifest: $catgo_manifest)" >&2
    exit 65
fi
CATGO_VASP_PREFLIGHT"""


async def write_vasp_input_manifest(
    hpc,
    work_dir: str,
    resolution: VaspCommandResolution,
    use_custodian: bool = False,
) -> None:
    """Write and validate the manifest on the connection owner's event loop."""
    command = build_vasp_input_manifest_command(
        work_dir, resolution, use_custodian=use_custodian
    )
    await hpc.run_on_owner(lambda: hpc.conn.run(command, check=True))
    await _audit_vasp_inputs(hpc, work_dir, resolution)


async def _audit_vasp_inputs(hpc, work_dir: str, resolution: VaspCommandResolution) -> None:
    """Run the input-side gates on what is about to be submitted.

    `verify_gates.precheck_inputs` existed but was only ever called from tests —
    an input audit nothing runs is not an audit. Reading the two files back costs
    one SSH call on a path that is already doing several, and a FAIL here is
    worth far more than the same finding after the job burns its allocation.
    Advisory by the D-057 policy: it logs, it does not block submission.
    """
    try:
        from catgo.mcp_tools import verify_gates
    except Exception:  # pragma: no cover - the audit must never break a submit
        return
    remote = _quote_remote_work_dir(work_dir)
    read = (
        "cd " + remote + " && for f in INCAR KPOINTS; do "
        "printf '<<<CATGO_%s>>>\n' \"$f\"; "
        "if [ -f \"$f\" ]; then cat \"$f\"; fi; done; "
        "printf '<<<CATGO_POTCAR_TITELS>>>\\n'; "
        "if [ -f POTCAR ]; then "
        "grep -E '^[[:space:]]*TITEL[[:space:]]*=' POTCAR || true; fi"
    )
    try:
        res = await hpc.run_on_owner(lambda: hpc.conn.run(read, check=False))
        text = res.stdout or ""
        incar = text.split("<<<CATGO_INCAR>>>", 1)[-1].split("<<<CATGO_KPOINTS>>>")[0]
        kpoints_block = text.split("<<<CATGO_KPOINTS>>>", 1)[-1] if "<<<CATGO_KPOINTS>>>" in text else ""
        kpoints = kpoints_block.split("<<<CATGO_POTCAR_TITELS>>>", 1)[0]
        titel_block = (
            text.split("<<<CATGO_POTCAR_TITELS>>>", 1)[-1]
            if "<<<CATGO_POTCAR_TITELS>>>" in text else ""
        )
        titels = [
            line.split("=", 1)[-1].strip()
            for line in titel_block.splitlines()
            if "=" in line and line.split("=", 1)[-1].strip()
        ]
        verdicts = verify_gates.precheck_inputs(
            incar,
            kpoints_text=kpoints or None,
            titels=titels or None,
            binary=resolution.binary_token,
        )
        failed = [v for v in verdicts if v.get("status") == "FAIL"]
        if failed:
            logger.warning(
                "VASP input precheck FAILED for %s: %s", work_dir,
                "; ".join(f"{v['gate']}: {v['detail']}" for v in failed),
            )
        else:
            logger.info(
                "VASP input precheck clean for %s (%d gates ran)",
                work_dir, sum(1 for v in verdicts if v.get("status") != "SKIP"),
            )
    except Exception:  # pragma: no cover
        logger.debug("VASP input precheck could not run for %s", work_dir, exc_info=True)
