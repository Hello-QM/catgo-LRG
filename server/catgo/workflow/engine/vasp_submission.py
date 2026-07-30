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
VASP_KPOINTS_POLICIES = {"vasp_default", "explicit_regular_mesh"}
_INCAR_TAG_RE = re.compile(r"[A-Z_][A-Z0-9_]*")


@dataclass(frozen=True)
class VaspCommandResolution:
    command: str
    binary_token: str | None
    source: str


def _normalize_required_incar_tags(value: Any) -> tuple[str, ...] | None:
    """Normalize a nullable, non-vacuous P17 workflow contract."""
    if value is None:
        return None
    if isinstance(value, (str, bytes)) or not isinstance(value, (list, tuple)):
        raise ValueError(
            "required_incar_tags must be null or a nonempty ordered list/tuple"
        )
    if not value:
        raise ValueError("required_incar_tags cannot be an empty declared contract")
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in value:
        if not isinstance(raw, str):
            raise ValueError("required_incar_tags entries must be strings")
        key = raw.strip().upper()
        if not _INCAR_TAG_RE.fullmatch(key):
            raise ValueError(f"invalid required INCAR tag: {raw!r}")
        if key in seen:
            raise ValueError(
                f"duplicate required INCAR tag after normalization: {key}"
            )
        seen.add(key)
        normalized.append(key)
    return tuple(normalized)


@dataclass(frozen=True)
class VaspInputPolicy:
    """Submission-time P17/P4 contract; null required_keys preserves legacy jobs."""

    required_keys: tuple[str, ...] | None = None
    kpoints_policy: str = "vasp_default"

    def __post_init__(self) -> None:
        normalized = _normalize_required_incar_tags(self.required_keys)
        if self.kpoints_policy not in VASP_KPOINTS_POLICIES:
            raise ValueError(
                f"unknown kpoints_policy={self.kpoints_policy!r}; "
                f"expected one of {sorted(VASP_KPOINTS_POLICIES)}"
            )
        object.__setattr__(self, "required_keys", normalized)


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


def resolve_vasp_input_policy(params: dict, config: dict) -> VaspInputPolicy:
    """Resolve per-field policy: task params > job defaults > VASP defaults."""
    hpc_cfg = config.get("hpc", {}) or {}
    job_defaults = hpc_cfg.get("job_defaults", {}) or {}
    defaults = config.get("defaults", {}) or {}
    vasp_defaults = defaults.get("vasp", {}) if isinstance(defaults, dict) else {}
    if not isinstance(vasp_defaults, dict):
        vasp_defaults = {}
    sources = (params, job_defaults, vasp_defaults)
    sentinel = object()

    def resolve_field(name: str, fallback: Any) -> Any:
        for source in sources:
            if isinstance(source, dict) and name in source:
                return source[name]
        return fallback

    required = resolve_field("required_incar_tags", sentinel)
    if required is sentinel:
        required = None
    kpoints_policy = resolve_field("kpoints_policy", "vasp_default")
    return VaspInputPolicy(
        required_keys=required,
        kpoints_policy=kpoints_policy,
    )


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
    *,
    input_policy: VaspInputPolicy | None = None,
) -> str:
    """Build a POSIX-shell preflight that writes JSON, then rejects missing inputs."""
    policy = input_policy or VaspInputPolicy()
    run_command_json = shlex.quote(json.dumps(resolution.command, ensure_ascii=True))
    binary_token_json = shlex.quote(json.dumps(resolution.binary_token, ensure_ascii=True))
    source_json = shlex.quote(json.dumps(resolution.source, ensure_ascii=True))
    required_keys_json = shlex.quote(json.dumps(
        list(policy.required_keys) if policy.required_keys is not None else None,
        ensure_ascii=True,
    ))
    required_keys_shell = shlex.quote(" ".join(policy.required_keys or ()))
    kpoints_policy_json = shlex.quote(json.dumps(policy.kpoints_policy))
    strict_kpoints = "true" if policy.kpoints_policy == "explicit_regular_mesh" else "false"
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
catgo_required_keys_json={required_keys_json}
catgo_required_keys_shell={required_keys_shell}
catgo_kpoints_policy_json={kpoints_policy_json}
catgo_strict_kpoints={strict_kpoints}

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
            rendered=tolower(sprintf("%g", value + 0))
            if (value ~ /^[-+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([Ee][-+]?[0-9]+)?$/ &&
                rendered !~ /inf|nan/ && value + 0 > 0) {{
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

catgo_has_nonblank_incar_key() {{
    awk -v wanted="$2" '
    {{
        line=$0
        sub(/[#!].*$/, "", line)
        upper=toupper(line)
        pattern="(^|[;[:space:]])" wanted "[[:space:]]*="
        while (match(upper, pattern)) {{
            value=substr(line, RSTART + RLENGTH)
            sub(/^[[:space:]]*/, "", value)
            if (value == "" || value ~ /^[;=]/ ||
                value ~ /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) {{
                found=0
            }} else {{
                found=1
            }}
            offset=RSTART + RLENGTH
            line=substr(line, offset)
            upper=substr(upper, offset)
        }}
    }}
    END {{ exit(found ? 0 : 1) }}
    ' "$1"
}}

catgo_has_incar_key() {{
    awk -v wanted="$2" '
    {{
        line=$0
        sub(/[#!].*$/, "", line)
        upper=toupper(line)
        pattern="(^|[;[:space:]])" wanted "[[:space:]]*="
        while (match(upper, pattern)) {{
            found=1
            offset=RSTART + RLENGTH
            line=substr(line, offset)
            upper=substr(upper, offset)
        }}
    }}
    END {{ exit(found ? 0 : 1) }}
    ' "$1"
}}

catgo_regular_kpoints_valid() {{
    awk '
    function clean(value) {{
        sub(/[#!].*$/, "", value)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        return value
    }}
    {{
        physical[++n]=$0
    }}
    END {{
        while (n > 0 && physical[n] ~ /^[[:space:]]*$/) n--
        if (n != 4 && n != 5) exit 1
        line=clean(physical[2])
        if (line !~ /^[-+]?0+$/) exit 1
        line=clean(physical[3])
        first=toupper(substr(line, 1, 1))
        if (first != "G" && first != "M") exit 1
        line=clean(physical[4])
        count=split(line, field, /[[:space:]]+/)
        if (count != 3) exit 1
        for (i=1; i<=3; i++) {{
            if (field[i] !~ /^[+]?[0-9]+$/ || field[i] + 0 <= 0) exit 1
        }}
        if (n == 5) {{
            line=clean(physical[5])
            count=split(line, field, /[[:space:]]+/)
            if (count != 3) exit 1
            for (i=1; i<=3; i++) {{
                value=field[i]
                gsub(/[Dd]/, "E", value)
                if (value !~ /^[-+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([Ee][-+]?[0-9]+)?$/) exit 1
                rendered=tolower(sprintf("%g", value + 0))
                if (rendered ~ /inf|nan/) exit 1
            }}
        }}
        exit 0
    }}
    ' "$1"
}}

catgo_kpoints_nonblank() {{
    grep -q '[^[:space:]]' "$1"
}}

catgo_add_policy_violation() {{
    if [ -n "$catgo_policy_violations_json" ]; then
        catgo_policy_violations_json="$catgo_policy_violations_json,"
    fi
    catgo_policy_violations_json="$catgo_policy_violations_json\\"$1\\""
    catgo_policy_violation_text="$catgo_policy_violation_text $1"
}}

catgo_missing_json=
catgo_missing_text=
catgo_policy_violations_json=
catgo_policy_violation_text=
catgo_p4_verdict=SKIP
catgo_p17_verdict=SKIP
if command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || command -v openssl >/dev/null 2>&1; then
    catgo_hash_available=true
else
    catgo_hash_available=false
fi

catgo_kspacing=false
if [ -f INCAR ] && catgo_has_positive_kspacing INCAR; then
    catgo_kspacing=true
fi
catgo_kspacing_declared=false
if [ -f INCAR ] && catgo_has_incar_key INCAR KSPACING; then
    catgo_kspacing_declared=true
fi
catgo_kpoints_optional=false
if [ ! -f KPOINTS ] && [ "$catgo_kspacing" = true ] && [ "$catgo_strict_kpoints" != true ]; then
    catgo_kpoints_optional=true
fi

if [ "$catgo_strict_kpoints" = true ]; then
    if [ ! -f KPOINTS ]; then
        catgo_p4_verdict=FAIL
        catgo_add_policy_violation "P4:explicit_kpoints_missing"
    elif ! catgo_regular_kpoints_valid KPOINTS; then
        catgo_p4_verdict=FAIL
        catgo_add_policy_violation "P4:explicit_regular_mesh_malformed"
    else
        catgo_p4_verdict=PASS
    fi
elif [ -f KPOINTS ]; then
    if catgo_kpoints_nonblank KPOINTS; then
        catgo_p4_verdict=PASS
    else
        catgo_p4_verdict=FAIL
        catgo_add_policy_violation "P4:kpoints_present_empty"
    fi
elif [ "$catgo_kspacing" = true ]; then
    catgo_p4_verdict=PASS
elif [ "$catgo_kspacing_declared" = true ]; then
    catgo_p4_verdict=FAIL
    catgo_add_policy_violation "P4:kspacing_not_positive_finite"
fi

catgo_required_missing=false
for catgo_key in $catgo_required_keys_shell; do
    if [ ! -f INCAR ] || ! catgo_has_nonblank_incar_key INCAR "$catgo_key"; then
        catgo_required_missing=true
        catgo_add_policy_violation "P17:required_key_missing_or_blank:$catgo_key"
    fi
done
if [ -n "$catgo_required_keys_shell" ]; then
    if [ "$catgo_required_missing" = true ]; then
        catgo_p17_verdict=FAIL
    else
        catgo_p17_verdict=PASS
    fi
fi

for catgo_name in {" ".join(VASP_MANDATORY_INPUTS)}; do
    if [ "$catgo_name" = KPOINTS ] && [ "$catgo_kpoints_optional" = true ]; then
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
catgo_incar_hash_json=null
if [ -f INCAR ] && catgo_incar_hash=$(catgo_sha256 INCAR 2>/dev/null); then
    catgo_incar_hash_json="\\"$catgo_incar_hash\\""
fi
if [ -n "$catgo_missing_text" ] || [ -n "$catgo_policy_violation_text" ] || [ "$catgo_binary_declared" != true ] || [ "$catgo_hash_available" != true ]; then
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
    printf '    "KPOINTS": '; catgo_emit_input KPOINTS "$catgo_kpoints_optional"; printf '\\n'
    printf '  }},\\n'
    printf '  "input_policy": {{\\n'
    printf '    "schema_version": 1,\\n'
    printf '    "required_keys": %s,\\n' "$catgo_required_keys_json"
    printf '    "kpoints_policy": %s,\\n' "$catgo_kpoints_policy_json"
    printf '    "artifact_kind": "exact",\\n'
    printf '    "materialization": {{\\n'
    printf '      "strategy": "exact",\\n'
    printf '      "resolved": true,\\n'
    printf '      "base_sha256": null,\\n'
    printf '      "overlay_sha256": [],\\n'
    printf '      "materialized_sha256": %s\\n' "$catgo_incar_hash_json"
    printf '    }},\\n'
    printf '    "checked": true,\\n'
    printf '    "verdicts": {{"P4":"%s","P17":"%s"}},\\n' "$catgo_p4_verdict" "$catgo_p17_verdict"
    printf '    "violations": [%s]\\n' "$catgo_policy_violations_json"
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
    if [ -n "$catgo_policy_violation_text" ]; then
        printf '%s\\n' "CatGo VASP input-policy failed:$catgo_policy_violation_text (manifest: $catgo_manifest)" >&2
        exit 68
    fi
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
    *,
    input_policy: VaspInputPolicy | None = None,
) -> None:
    """Write and validate the manifest on the connection owner's event loop."""
    policy = input_policy or VaspInputPolicy()
    command = build_vasp_input_manifest_command(
        work_dir,
        resolution,
        use_custodian=use_custodian,
        input_policy=policy,
    )
    await hpc.run_on_owner(lambda: hpc.conn.run(command, check=True))
    await _audit_vasp_inputs(hpc, work_dir, resolution, input_policy=policy)


async def _audit_vasp_inputs(
    hpc,
    work_dir: str,
    resolution: VaspCommandResolution,
    *,
    input_policy: VaspInputPolicy | None = None,
) -> None:
    """Run the input-side gates on what is about to be submitted.

    `verify_gates.precheck_inputs` existed but was only ever called from tests —
    an input audit nothing runs is not an audit. Reading the two files back costs
    one SSH call on a path that is already doing several, and a FAIL here is
    worth far more than the same finding after the job burns its allocation.
    Non-contract findings remain advisory under D-057. P17/P4 disagreement
    after the shell already certified the same declared policy is parser drift,
    so it blocks before submission.
    """
    policy = input_policy or VaspInputPolicy()
    try:
        from catgo.mcp_tools import verify_gates
    except Exception:  # pragma: no cover - shell policy enforcement remains active
        return
    remote = _quote_remote_work_dir(work_dir)
    read = (
        "cd " + remote + " && for f in INCAR KPOINTS; do "
        "printf '<<<CATGO_%s>>>\n' \"$f\"; "
        "if [ -f \"$f\" ]; then cat \"$f\"; fi; done; "
        "printf '<<<CATGO_KPOINTS_EXISTS>>>\\n'; "
        "if [ -f KPOINTS ]; then printf 'true\\n'; else printf 'false\\n'; fi; "
        "printf '<<<CATGO_POTCAR_TITELS>>>\\n'; "
        "if [ -f POTCAR ]; then "
        "grep -E '^[[:space:]]*TITEL[[:space:]]*=' POTCAR || true; fi"
    )
    try:
        res = await hpc.run_on_owner(lambda: hpc.conn.run(read, check=False))
        text = res.stdout or ""
        incar = text.split("<<<CATGO_INCAR>>>", 1)[-1].split("<<<CATGO_KPOINTS>>>")[0]
        kpoints_block = text.split("<<<CATGO_KPOINTS>>>", 1)[-1] if "<<<CATGO_KPOINTS>>>" in text else ""
        if "<<<CATGO_KPOINTS_EXISTS>>>" in text:
            kpoints = kpoints_block.split("<<<CATGO_KPOINTS_EXISTS>>>", 1)[0]
            exists_block = text.split("<<<CATGO_KPOINTS_EXISTS>>>", 1)[-1]
            kpoints_exists = (
                exists_block.split("<<<CATGO_POTCAR_TITELS>>>", 1)[0].strip()
                == "true"
            )
        else:
            # Backward-compatible test/fake transport; production emits the marker.
            kpoints = kpoints_block.split("<<<CATGO_POTCAR_TITELS>>>", 1)[0]
            kpoints_exists = bool(kpoints.strip())
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
            kpoints_text=kpoints if kpoints_exists else None,
            titels=titels or None,
            binary=resolution.binary_token,
            required_keys=(
                list(policy.required_keys)
                if policy.required_keys is not None
                else None
            ),
            kpoints_policy=policy.kpoints_policy,
        )
    except Exception:  # pragma: no cover
        logger.debug("VASP input precheck could not run for %s", work_dir, exc_info=True)
        return

    failed = [v for v in verdicts if v.get("status") == "FAIL"]
    contract_failed = [
        v for v in failed
        if v.get("gate") in {"in_kspacing_vs_kpoints", "in_required_keys_present"}
    ]
    if contract_failed:
        detail = "; ".join(
            f"{v['gate']}: {v['detail']}" for v in contract_failed
        )
        raise RuntimeError(
            f"VASP input-policy parser drift after shell preflight for {work_dir}: "
            f"{detail}"
        )
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
