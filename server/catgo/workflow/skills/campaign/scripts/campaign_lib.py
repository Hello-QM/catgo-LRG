"""Reference library for md-orchestration campaigns.

Lives in the campaign SKILL's scripts/ dir, NOT baked into the CLI registry, so
it stays adaptable for the unforeseen (mixed software, odd clusters, novel calc
types). The runnable entrypoints (new_campaign.py / fetch_ref.py / submit_calc.py
/ poll.py) are thin wrappers around these functions — read them as reference and
adapt freely.

ssh is plain stdlib subprocess on an ssh *alias* (ControlMaster / ~/.ssh/config
handles auth) — matches "just use ssh sbatch". No catgo-package coupling.
"""
from __future__ import annotations

import datetime
import posixpath
import re
import shlex
import subprocess
from dataclasses import dataclass, fields
from pathlib import Path


class CampaignError(Exception):
    """A campaign operation failed (gate not satisfied, ssh/scp/sbatch error)."""


SUBDIRS = ["literature", "refs", "scripts", "calc", "analysis", "report", "archive"]


# ============================ naming (never hashes) =========================

def slugify(name: str) -> str:
    s = name.strip()
    s = re.sub(r"[^\w\s.-]", "", s)   # keep word chars, whitespace, dot, hyphen
    s = re.sub(r"\s+", "-", s)
    s = s.strip("-_.")
    return s or "item"


def disambiguate(name: str, existing: set[str]) -> str:
    if name not in existing:
        return name
    i = 2
    while f"{name}-{i}" in existing:
        i += 1
    return f"{name}-{i}"


def tldr_header(title: str, summary: str) -> str:
    return f"# {title}\n\n> **TL;DR:** {summary}\n"


def remote_mirror_path(remote_base: str, project_name: str, rel_path: str) -> str:
    return posixpath.join(
        remote_base.rstrip("/"), slugify(project_name), rel_path.strip("/")
    )


# ================================ STATUS.md ================================

_STATUS_FIELDS = [
    "state", "cluster", "job_type", "remote_dir",
    "jobid", "exit_code", "submitted_at", "updated_at",
]


@dataclass
class Status:
    state: str = "PENDING"
    cluster: str = ""
    job_type: str = ""
    remote_dir: str = ""
    jobid: str = ""
    exit_code: str = ""        # sacct ExitCode once terminal (e.g. "0:0" / "1:0")
    submitted_at: str = ""
    updated_at: str = ""
    title: str = ""


def render_status(s: Status) -> str:
    summary = s.state + (f" on {s.cluster}" if s.cluster else "")
    summary += f" (job {s.jobid})" if s.jobid else ""
    lines = [tldr_header(s.title or "calc", summary), ""]
    lines += [f"{k}: {getattr(s, k)}" for k in _STATUS_FIELDS]
    return "\n".join(lines) + "\n"


def _parse_kv(text: str, allowed: set[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if ":" not in line or line.startswith("#") or line.startswith(">"):
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        if key in allowed:
            out[key] = val.strip()
    return out


def parse_status(text: str) -> Status:
    s = Status(**_parse_kv(text, set(_STATUS_FIELDS)))
    for raw in text.splitlines():
        if raw.startswith("# "):
            s.title = raw[2:].strip()
            break
    return s


def update_status(text: str, **changes: str) -> str:
    s = parse_status(text)
    valid = {f.name for f in fields(Status)}
    for k, v in changes.items():
        if k in valid:
            setattr(s, k, v)
    return render_status(s)


# ================================ cluster.md ===============================

REQUIRED = [
    "cluster", "ssh_host", "account", "partition", "walltime", "ntasks",
    "run_command", "load_method", "potcar_root", "python_env", "remote_base",
]


@dataclass
class ClusterConfig:
    cluster: str = ""
    ssh_host: str = ""
    account: str = ""
    partition: str = ""
    walltime: str = ""
    ntasks: str = ""
    run_command: str = ""
    load_method: str = ""
    potcar_root: str = ""
    python_env: str = ""
    remote_base: str = ""
    reference_script: str = ""


def render_cluster(c: ClusterConfig) -> str:
    lines = [
        tldr_header("cluster (CONFIRMED env)",
                    "compute env — never guessed; see the setup gate"),
        "",
    ]
    lines += [f"{f.name}: {getattr(c, f.name)}" for f in fields(ClusterConfig)]
    return "\n".join(lines) + "\n"


def parse_cluster(text: str) -> ClusterConfig:
    names = {f.name for f in fields(ClusterConfig)}
    return ClusterConfig(**_parse_kv(text, names))


def missing_fields(c: ClusterConfig) -> list[str]:
    return [k for k in REQUIRED if not getattr(c, k).strip()]


def is_submittable(c: ClusterConfig) -> bool:
    return not missing_fields(c)


# ========================== job-script adaptation ==========================

def _set_sbatch(lines: list[str], key: str, value: str) -> list[str]:
    directive = f"#SBATCH --{key}="
    new_line = f"#SBATCH --{key}={value}"
    out: list[str] = []
    replaced = False
    for line in lines:
        if line.strip().startswith(directive):
            out.append(new_line)
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.insert(1 if (out and out[0].startswith("#!")) else 0, new_line)
    return out


def adapt_job_script(reference: str, *, job_name: str, work_dir: str,
                     account: str, partition: str, walltime: str, ntasks: str,
                     run_command: str) -> str:
    """Adapt a user reference .sb: keep its module/conda preamble verbatim;
    override resource #SBATCH directives; ensure cd work_dir + run command."""
    lines = reference.splitlines()
    if not lines or not lines[0].startswith("#!"):
        lines = ["#!/bin/bash"] + lines
    for key, val in (("job-name", job_name), ("account", account),
                     ("partition", partition), ("time", walltime),
                     ("ntasks", ntasks)):
        if val:
            lines = _set_sbatch(lines, key, val)
    body = "\n".join(lines)
    if work_dir and f'cd "{work_dir}"' not in body and f"cd {work_dir}" not in body:
        lines.append(f'cd "{work_dir}"')
    if run_command and run_command not in "\n".join(lines):
        lines.append(run_command)
    return "\n".join(lines) + "\n"


# ================================= squeue ==================================

_SQUEUE_MAP = {"RUNNING": "RUNNING", "COMPLETING": "RUNNING",
               "PENDING": "PENDING", "CONFIGURING": "PENDING"}


def parse_squeue(output: str) -> str:
    s = output.strip()
    return s.splitlines()[0].strip() if s else ""


def map_state(squeue_state: str, had_jobid: bool) -> str:
    # squeue only knows queued states. When a job has LEFT the queue, poll_campaign
    # asks sacct for the terminal verdict (DONE vs FAILED) — see map_sacct. This
    # empty->DONE branch is the fallback used only when sacct is unavailable.
    if not squeue_state:
        return "DONE" if had_jobid else "PENDING"
    return _SQUEUE_MAP.get(squeue_state, squeue_state)


# sacct gives the SCHEDULER's terminal verdict. NOTE: COMPLETED only means the
# batch script exited 0 — it does NOT mean the calculation converged. The real
# scientific error is found only by reading the work_dir outputs at the
# agent-driven collect step (-> result.md / LESSONS.md).
_SACCT_DONE = {"COMPLETED"}
_SACCT_RUNNING = {"RUNNING", "COMPLETING"}
_SACCT_PENDING = {"PENDING", "CONFIGURING", "REQUEUED", "RESIZING"}
_SACCT_FAILED = {"FAILED", "TIMEOUT", "CANCELLED", "OUT_OF_MEMORY", "NODE_FAIL",
                 "BOOT_FAIL", "DEADLINE", "PREEMPTED", "REVOKED"}


def parse_sacct(output: str) -> tuple[str, str]:
    """First job line of ``sacct -n -P -o State,ExitCode`` -> (State, ExitCode).

    State may carry a suffix (e.g. ``CANCELLED by 42``) — keep only the keyword.
    """
    for raw in output.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split("|")
        state = parts[0].split()[0] if parts[0].strip() else ""
        exitcode = parts[1].strip() if len(parts) > 1 else ""
        return state, exitcode
    return "", ""


def map_sacct(state: str) -> str:
    """sacct State -> our state, or "" if unknown (caller falls back)."""
    s = state.upper()
    if s in _SACCT_DONE:
        return "DONE"
    if s in _SACCT_RUNNING:
        return "RUNNING"
    if s in _SACCT_PENDING:
        return "PENDING"
    if s in _SACCT_FAILED:
        return "FAILED"
    return ""


# ============================== ssh wrappers ===============================
# Plain stdlib subprocess on an ssh alias. ControlMaster / ~/.ssh/config handle
# auth. All ssh/scp go through _run so tests can monkeypatch one seam.

def _run(argv: list[str]) -> tuple[int, str, str]:
    cp = subprocess.run(argv, capture_output=True, text=True, timeout=120, check=False)
    return cp.returncode, cp.stdout or "", cp.stderr or ""


def ssh_run(alias: str, remote_cmd: str) -> str:
    login = f"bash -l -c {shlex.quote(remote_cmd)}"
    rc, out, err = _run(["ssh", "-o", "BatchMode=yes", alias, login])
    if rc != 0:
        raise CampaignError(f"ssh {alias}: {err.strip() or f'rc={rc}'}")
    return out


def scp_to(alias: str, local_path: str, remote_path: str) -> None:
    rc, _, err = _run(["scp", "-o", "BatchMode=yes", local_path,
                       f"{alias}:{remote_path}"])
    if rc != 0:
        raise CampaignError(f"scp -> {alias}:{remote_path}: {err.strip() or rc}")


def scp_from(alias: str, remote_path: str, local_path: str) -> None:
    rc, _, err = _run(["scp", "-o", "BatchMode=yes",
                       f"{alias}:{remote_path}", local_path])
    if rc != 0:
        raise CampaignError(f"scp <- {alias}:{remote_path}: {err.strip() or rc}")


def sbatch(alias: str, remote_dir: str, script: str) -> str:
    out = ssh_run(alias, f"cd {shlex.quote(remote_dir)} && sbatch {shlex.quote(script)}")
    ids = re.findall(r"(\d+)", out)
    if not ids:
        raise CampaignError(f"could not parse jobid from sbatch: {out.strip()!r}")
    return ids[-1]


def squeue(alias: str, jobid: str) -> str:
    # A job that has LEFT the queue makes `squeue -j <id>` exit nonzero with
    # "Invalid job id specified" (not empty output) on some SLURM builds. Treat
    # that as "not queued" ("") so poll_campaign falls through to the sacct
    # terminal verdict instead of crashing. Real ssh failures still raise.
    try:
        return ssh_run(alias, f"squeue -j {shlex.quote(jobid)} -h -o %T")
    except CampaignError as exc:
        if "invalid job id" in str(exc).lower():
            return ""
        raise


def sacct(alias: str, jobid: str) -> str:
    """Terminal accounting record for a job that has left the queue."""
    return ssh_run(alias, f"sacct -j {shlex.quote(jobid)} -n -P -o State,ExitCode")


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ============================== orchestration ==============================

_SKIP_UPLOAD = {"STATUS.md", "LESSONS.md", "plan.md", "result.md",
                "README.md", "INDEX.md"}

_SUBDIR_DESC = {
    "literature": "papers (MinerU md) + repos + extracted-skills — grounds the plan",
    "refs": "shared reference calcs (H2, clean slab) — computed once",
    "scripts": "all scripts (incl. reference_job.sb) + usage",
    "calc": "the calculations, named by funnel stage / candidate",
    "analysis": "cross-calc aggregation (ranking, volcano, funnel)",
    "report": "group-meeting / seminar reports",
    "archive": "outdated / abandoned calculations",
}


def _plan_blank(name: str) -> str:
    return (tldr_header(f"{name} — plan", "campaign playbook: stages, decision points")
            + "\n## Stages\n1. <stage> — <what / decision point>\n\n"
            "## Decision points\n- <criterion to cross to the next stage>\n")


def _plan_saa_her(name: str) -> str:
    return tldr_header(f"{name} — plan", "SAA HER screening funnel") + """
## Stages

1. **Stability — formation energy** (`calc/01-stability-formation-energy/`)
   Per candidate SAA slab: geo_opt -> energy -> E_form.
   **decision point:** keep candidates with E_form below the user-set threshold.

2. **Activity — dG_H\\*** (`calc/02-activity-dGH/`)
   Per survivor: clean slab + *H slab -> geo_opt -> freq -> gibbs -> dG_H*.
   **decision point:** rank by |dG_H*|; report the top candidates.

3. **Analysis** (`analysis/`)
   E_form ranking + dG_H* volcano + funnel summary (P2 aggregation).

## References
- `refs/` H2 + clean host slab — computed once, reused by all candidates.
"""


def scaffold_project(base, name: str, template: str = "blank") -> Path:
    root = Path(base).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    (root / "README.md").write_text(
        tldr_header(name, f"Campaign project: {name}. Goal: <fill in>.")
        + "\n## Goal\n<what this answers>\n\n## Current stage\n<stage>\n"
    )
    index = [tldr_header(f"{name} — index", "navigation: role of each subfolder"), ""]
    index.append("- `plan.md` — campaign playbook (stages / funnel / decision points)")
    index.append("- `cluster.md` — CONFIRMED compute env (never guessed)")
    index += [f"- `{d}/` — {_SUBDIR_DESC[d]}" for d in SUBDIRS]
    (root / "INDEX.md").write_text("\n".join(index) + "\n")
    (root / "cluster.md").write_text(
        render_cluster(ClusterConfig())
        + "\n<!-- Fill via the setup gate; NEVER guess. "
        "Run catgo_validate_config before the first submit. -->\n"
    )
    # Thin agent bootstrap: an agent launched in this folder reads it and knows to
    # drive/resume the campaign. Defers the project description to README (no overlap).
    (root / "CLAUDE.md").write_text(
        "# Agent bootstrap — CatGo md-orchestration campaign\n\n"
        "> **TL;DR:** Agent launched here — drive/resume this campaign via the "
        "`catgo-campaign` skill; state is in these files, not in chat.\n\n"
        "This folder is a **CatGo md-orchestration campaign**: file-first, state lives in\n"
        "these files (not in chat). Drive it with the **`catgo-campaign`** skill via\n"
        "`catgo campaign <action> ...` (use your catgo env's binary if not on PATH). This is\n"
        "NOT the DB workflow engine.\n\n"
        "**What this project is:** see `README.md` (not duplicated here).\n\n"
        "**Resume (no chat history needed):** read `README.md` → `plan.md` (+ each\n"
        "`calc/<stage>/plan.md`) → `cluster.md` → every `calc/**/STATUS.md` → `result.md`\n"
        "→ `LESSONS.md` = done / running / next. Then continue the loop, delegating each\n"
        "poll to a subagent.\n\n"
        "**Rules:** never guess cluster/POTCAR/binary (keep in `cluster.md`); input-file\n"
        "gate before submit (review-gated unless the user says YOLO); `submit` refuses an\n"
        "already-RUNNING calc (`--force` to override); log every cancel/rebuild/gotcha to\n"
        "the calc's `LESSONS.md`; keep `INDEX.md`/`README.md` current. Full conventions: the\n"
        "`catgo-campaign` skill.\n"
    )
    for d in SUBDIRS:
        (root / d).mkdir(exist_ok=True)
        (root / d / "INDEX.md").write_text(tldr_header(f"{d}/", _SUBDIR_DESC[d]))

    if template == "saa_her":
        (root / "plan.md").write_text(_plan_saa_her(name))
        for stage in ("01-stability-formation-energy", "02-activity-dGH"):
            sdir = root / "calc" / stage
            sdir.mkdir(parents=True, exist_ok=True)
            (sdir / "INDEX.md").write_text(
                tldr_header(f"{stage}/", "one folder per candidate")
            )
    else:
        (root / "plan.md").write_text(_plan_blank(name))
    return root


def fetch_reference(project, alias: str, remote_path: str) -> Path:
    dest = Path(project).expanduser() / "scripts" / "reference_job.sb"
    dest.parent.mkdir(parents=True, exist_ok=True)
    scp_from(alias, remote_path, str(dest))
    return dest


def sanity_check_inputs(calc_dir, *, force: bool = False) -> list[str]:
    """Pre-submission scientific-config gate. Validates the calc's VASP inputs
    (ENCUT vs ENMAX, k-mesh density, ISMEAR/SIGMA, magnetic & closed-shell ISPIN)
    and returns the warning lines to surface. Raises CampaignError on an
    error-severity check unless force=True (the human-in-the-loop override:
    CatGo surfaces the issue + the fix, the user decides). No-ops (returns []) if
    vasp_sanity is unavailable or the folder has no INCAR to validate."""
    try:
        import vasp_sanity as _vs
    except ImportError:
        return []
    is_gas = _vs.detect_is_gas(calc_dir)
    checks = _vs.validate_calc_dir(calc_dir, is_gas=is_gas)
    ok, lines = _vs.summarize(checks)
    if not ok and not force:
        bad = "; ".join(f"{c.name}: {c.detail}" for c in checks
                        if c.severity == "error" and not c.ok)
        raise CampaignError(
            f"scientific-config check failed -> {bad}. "
            "Fix the inputs, or pass --force to submit anyway after review."
        )
    return lines


def submit_calc(project, calc_rel: str, alias: str, job_type: str = "",
                now: str | None = None, force: bool = False) -> dict:
    """Gate-enforcing submit: refuses an unconfirmed cluster.md or a missing
    reference script (so cluster paths are never guessed), then adapts the
    reference script, scp's the calc inputs, sbatch's, and writes STATUS.md.

    Idempotent re-entry guard: refuses if this calc already has a STATUS.md with
    state RUNNING/PENDING (a resumed agent must not double-submit a live job).
    Pass force=True to resubmit anyway (e.g. after a rebuild)."""
    proj = Path(project).expanduser()
    calc_rel = calc_rel.strip("/")
    local = proj / calc_rel
    if not local.is_dir():
        raise CampaignError(f"calc folder not found: {local}")

    status_file = local / "STATUS.md"
    if status_file.is_file() and not force:
        prev = parse_status(status_file.read_text())
        if prev.state in ("RUNNING", "PENDING"):
            raise CampaignError(
                f"{calc_rel} already {prev.state} (job {prev.jobid}). Refusing to "
                "double-submit; poll first, or pass force=True (--force) to resubmit."
            )

    cfg = (parse_cluster((proj / "cluster.md").read_text())
           if (proj / "cluster.md").is_file() else ClusterConfig())
    miss = missing_fields(cfg)
    if miss:
        raise CampaignError(
            f"cluster.md not confirmed — missing: {', '.join(miss)}. "
            "Run the setup gate; never guess cluster paths."
        )
    ref = proj / "scripts" / "reference_job.sb"
    if not ref.is_file():
        raise CampaignError(
            "no scripts/reference_job.sb — provide one "
            "(local file, or pull a remote path with fetch_ref.py)."
        )

    # Scientific-config gate: validate VASP inputs before shipping (blocks on a
    # hard physics error unless force; warnings are returned to be surfaced).
    warnings = sanity_check_inputs(local, force=force)

    use_alias = alias or cfg.ssh_host
    job_name = calc_rel.rsplit("/", 1)[-1]
    # Remote mirrors the LOCAL tree: use the project folder basename, so the
    # remote dir is identical to the local one (a true mirror, not the --name).
    remote_dir = remote_mirror_path(cfg.remote_base, proj.name, calc_rel)
    job_sb = adapt_job_script(
        ref.read_text(), job_name=job_name, work_dir=remote_dir,
        account=cfg.account, partition=cfg.partition, walltime=cfg.walltime,
        ntasks=cfg.ntasks, run_command=cfg.run_command,
    )
    (local / "job.sb").write_text(job_sb)

    ssh_run(use_alias, f"mkdir -p {shlex.quote(remote_dir)}")
    for f in sorted(local.iterdir()):
        if f.is_file() and f.name not in _SKIP_UPLOAD:
            scp_to(use_alias, str(f), f"{remote_dir}/{f.name}")
    jobid = sbatch(use_alias, remote_dir, "job.sb")

    ts = now or _utc_now()
    (local / "STATUS.md").write_text(render_status(Status(
        title=job_name, state="RUNNING", cluster=cfg.cluster, job_type=job_type,
        remote_dir=remote_dir, jobid=jobid, submitted_at=ts, updated_at=ts,
    )))
    return {"jobid": jobid, "remote_dir": remote_dir, "job_name": job_name,
            "warnings": warnings}


def poll_campaign(project, alias: str, now: str | None = None) -> list[str]:
    proj = Path(project).expanduser()
    updated: list[str] = []
    for sf in sorted(proj.glob("calc/**/STATUS.md")):
        st = parse_status(sf.read_text())
        if st.state not in ("PENDING", "RUNNING") or not st.jobid:
            continue
        sq_state = parse_squeue(squeue(alias, st.jobid))
        extra: dict[str, str] = {}
        if sq_state:                          # still in the queue
            new_state = map_state(sq_state, had_jobid=True)
        else:                                 # left queue -> sacct terminal verdict
            try:
                sacct_state, exitcode = parse_sacct(sacct(alias, st.jobid))
            except (CampaignError, OSError):
                sacct_state, exitcode = "", ""
            new_state = map_sacct(sacct_state) or "DONE"   # fallback if sacct absent
            if exitcode:
                extra["exit_code"] = exitcode
        if new_state != st.state:
            sf.write_text(update_status(
                sf.read_text(), state=new_state, updated_at=now or _utc_now(), **extra
            ))
            updated.append(f"{sf.parent.name}: {st.state}->{new_state}")
    return updated


# ================================= archive =================================
# Explicit move + propose-only. We NEVER auto-decide what is stale: funnel
# rejects (DONE with a high E_form) are real data the analysis needs, so they are
# never proposed. Only the user (or a clear FAILED signal they confirm) archives.

def archive_calc(project, calc_rel: str, reason: str = "",
                 now: str | None = None) -> Path:
    """Move a calc folder into ``archive/`` (readable mirror) + leave a tombstone.

    Refuses anything outside ``calc/``. On a name clash in archive/, uses a
    readable ``-2`` suffix (never a hash).
    """
    proj = Path(project).expanduser()
    calc_rel = calc_rel.strip("/")
    if not calc_rel.startswith("calc/"):
        raise CampaignError(f"can only archive calc/ folders, got: {calc_rel}")
    src = proj / calc_rel
    if not src.is_dir():
        raise CampaignError(f"calc folder not found: {src}")

    dest = proj / "archive" / calc_rel[len("calc/"):]
    base = dest
    i = 2
    while dest.exists():
        dest = base.parent / f"{base.name}-{i}"
        i += 1
    dest.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dest)                      # move the whole folder

    ts = now or _utc_now()
    src.mkdir(parents=True, exist_ok=True)
    (src / "ARCHIVED.md").write_text(
        tldr_header(f"ARCHIVED: {src.name}", f"moved to {dest} on {ts}")
        + f"\nmoved_to: {dest}\nwhen: {ts}\nreason: {reason}\n")
    return dest


def archive_candidates(project) -> list[dict]:
    """Propose calcs that look archivable (STATUS=FAILED). Never moves anything.

    Funnel rejects (DONE with a high E_form) are NOT proposed — they are data the
    ranking/volcano/funnel need.
    """
    proj = Path(project).expanduser()
    out: list[dict] = []
    for sf in sorted(proj.glob("calc/**/STATUS.md")):
        st = parse_status(sf.read_text())
        if st.state == "FAILED":
            out.append({"calc": sf.parent.relative_to(proj).as_posix(),
                        "reason": f"STATUS=FAILED (exit {st.exit_code or '?'})"})
    return out


# ================================ result.md ================================

def render_result(name: str, values: dict, tldr: str = "") -> str:
    summary = tldr or ", ".join(f"{k}={v}" for k, v in values.items()) or "no values"
    lines = [tldr_header(f"result: {name}", summary), ""]
    lines += [f"{k}: {v}" for k, v in values.items()]
    return "\n".join(lines) + "\n"


def parse_result(text: str) -> dict:
    """Parse a result.md's ``key: value`` lines; coerce numbers to float."""
    out: dict = {}
    for raw in text.splitlines():
        line = raw.strip()
        if ":" not in line or line.startswith("#") or line.startswith(">"):
            continue
        key, _, val = line.partition(":")
        key, val = key.strip(), val.strip()
        if not key:
            continue
        try:
            out[key] = float(val)
        except ValueError:
            out[key] = val
    return out
