# CatGO Campaign (md-orchestration) — MVP Implementation Plan (skill-first)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a file-first, agent-in-the-loop "campaign" mode to CatGO as a **SKILL with reference scripts** (not baked-in CLI ops) — a human-readable folder + markdown tree the agent drives to run multi-step HPC campaigns, bypassing the DB engine.

**Architecture:** Everything ships under `server/catgo/workflow/skills/campaign/`. `SKILL.md` is the brain (conventions, gates, loop protocol). `scripts/campaign_lib.py` is an adaptable reference library (naming / STATUS.md / cluster.md gate / job-script adaptation / squeue / stdlib-ssh wrappers / orchestration). Thin runnable entrypoints (`new_campaign.py` / `fetch_ref.py` / `submit_calc.py` / `poll.py`) wrap it. **Safety gates live in the runnable code** (`submit_calc` hard-refuses an unconfirmed `cluster.md` or a missing reference script) — so "never guess cluster paths" is enforced, not merely suggested. ssh is plain stdlib subprocess on an ssh **alias** (ControlMaster handles auth); no catgo-package coupling, so the scripts are portable reference the agent can read and adapt.

**Tech Stack:** Python 3.11 stdlib only (subprocess/pathlib/dataclasses/re). pytest for dev verification (not a CI gate). No new dependencies, no registry/models wiring.

**Spec:** `docs/superpowers/specs/2026-06-06-catgo-campaign-md-orchestration-design.md`

**Why skill-first (not CLI ops):** a registered CLI op with fixed params re-introduces the rigid, schema-locked shape we rejected for the DB engine. Reference scripts stay adaptable for mixed software / odd clusters / novel calc types, match how Claude Code skills already work, and are lighter to ship and maintain.

**Scope:** MVP = scaffolder + reference library + submit/poll/fetch via simple ssh sbatch + cluster.md env gate + reference-script adaptation + SKILL + one SAA-HER template. P2 (analysis aggregation / volcano / funnel, report generation, archive automation, mode-selection GUI, MinerU literature ingestion, skill promotion) is a separate plan.

**Conventions / gotchas:**
- catgo python: `/home/james0001/miniforge3/envs/catgo/bin/python`.
- Run tests from the scripts dir so `import campaign_lib` resolves (no `__init__.py` there): `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_lib.py -v`.
- Pre-commit hook runs `deno fmt` but **excludes `.md`** (and does not touch these `.py` under skills? it formats `.py`? `deno fmt` only does JS/TS/JSON/md — Python is untouched). So nothing reformats these files; commit as written.
- Do NOT start/stop the shared `:8000` backend — these are pure scripts + unit tests, no server needed.

---

## File Structure

All new, all under `server/catgo/workflow/skills/campaign/`:
- `SKILL.md` — the agent playbook (conventions, two-level plan, progressive-md, gates, loop, literature flow, how to run the scripts).
- `scripts/campaign_lib.py` — reference library: `slugify`/`disambiguate`/`tldr_header`/`remote_mirror_path`; `Status` + render/parse/update; `ClusterConfig` + parse/render/`missing_fields`/`is_submittable`; `adapt_job_script`; `parse_squeue`/`map_state`; stdlib-ssh wrappers (`_run`/`ssh_run`/`scp_to`/`scp_from`/`sbatch`/`squeue`); orchestration (`scaffold_project`/`fetch_reference`/`submit_calc`/`poll_campaign`); `CampaignError`.
- `scripts/new_campaign.py` / `fetch_ref.py` / `submit_calc.py` / `poll.py` — thin argparse entrypoints.
- `scripts/INDEX.md` — pointer describing each script + usage.
- `scripts/test_campaign_lib.py` — dev-verification tests for the error-prone logic + the submit gate.
- `templates/saa_her/plan.md` — the SAA-HER campaign playbook template.

---

### Task 1: `campaign_lib.py` — pure helpers (naming / STATUS / cluster gate / job-script / squeue)

**Files:**
- Create: `server/catgo/workflow/skills/campaign/scripts/campaign_lib.py` (pure section)
- Test: `server/catgo/workflow/skills/campaign/scripts/test_campaign_lib.py` (pure section)

- [ ] **Step 1: Write the failing test**

Create `server/catgo/workflow/skills/campaign/scripts/test_campaign_lib.py`:

```python
"""campaign_lib — dev verification for the error-prone, safety-critical logic."""
import campaign_lib as cl


# ---- naming: readable, never hashes ----

def test_slugify_preserves_readable_identifiers():
    assert cl.slugify("Pt1-Cu_SAA") == "Pt1-Cu_SAA"
    assert cl.slugify("01-stability-formation-energy") == "01-stability-formation-energy"


def test_slugify_spaces_to_hyphen_strips_unsafe_and_colon():
    assert cl.slugify("SAA HER") == "SAA-HER"
    assert cl.slugify("a/b:c") == "abc"
    assert cl.slugify("///") == "item"


def test_disambiguate_readable_suffix():
    assert cl.disambiguate("x", set()) == "x"
    assert cl.disambiguate("x", {"x"}) == "x-2"
    assert cl.disambiguate("x", {"x", "x-2"}) == "x-3"


def test_tldr_header():
    h = cl.tldr_header("T", "S")
    assert h.startswith("# T\n")
    assert "**TL;DR:** S" in h


def test_remote_mirror_path_readable_no_colon():
    p = cl.remote_mirror_path("/base", "SAA HER", "calc/01-x/Pt1-Cu_SAA")
    assert p == "/base/SAA-HER/calc/01-x/Pt1-Cu_SAA"
    assert ":" not in p


# ---- STATUS.md ----

def test_status_roundtrip_and_update():
    s = cl.Status(title="c", state="RUNNING", cluster="expanse", jobid="55",
                  remote_dir="/base/SAA-HER/calc/01-x/c", submitted_at="t0",
                  updated_at="t0", job_type="vasp geo_opt")
    text = cl.render_status(s)
    assert "**TL;DR:**" in text
    s2 = cl.parse_status(text)
    assert s2.state == "RUNNING" and s2.jobid == "55"
    text2 = cl.update_status(text, state="DONE", updated_at="t1")
    s3 = cl.parse_status(text2)
    assert s3.state == "DONE" and s3.updated_at == "t1" and s3.jobid == "55"


# ---- cluster.md gate ----

def test_cluster_gate_blocks_empty_and_lists_missing():
    c = cl.ClusterConfig()
    miss = cl.missing_fields(c)
    for req in cl.REQUIRED:
        assert req in miss
    assert cl.is_submittable(c) is False


def test_cluster_full_is_submittable_roundtrip():
    c = cl.ClusterConfig(
        cluster="expanse", ssh_host="expanse", account="sdp126",
        partition="shared", walltime="12:00:00", ntasks="64",
        run_command="srun vasp_std", load_method="source setvars.sh",
        potcar_root="/pot", python_env="conda activate pmg",
        remote_base="/remote/base",
    )
    assert cl.missing_fields(c) == []
    assert cl.is_submittable(c) is True
    c2 = cl.parse_cluster(cl.render_cluster(c))
    assert c2.run_command == "srun vasp_std" and cl.is_submittable(c2)


# ---- job-script adaptation: preserve preamble, override resources ----

_REF = (
    "#!/bin/bash\n#SBATCH --job-name=old\n#SBATCH --time=01:00:00\n"
    "source /home/wli7/intel/oneapi/setvars.sh\nconda activate pmg\n"
    "srun vasp_std > vasp.log 2>&1\n"
)


def test_adapt_overrides_directives_keeps_preamble_once():
    out = cl.adapt_job_script(
        _REF, job_name="Pt1-Cu_SAA", work_dir="/w", account="sdp126",
        partition="shared", walltime="12:00:00", ntasks="64",
        run_command="srun vasp_std",
    )
    assert "#SBATCH --job-name=Pt1-Cu_SAA" in out
    assert "#SBATCH --time=12:00:00" in out
    assert "#SBATCH --account=sdp126" in out
    assert "old" not in out and "01:00:00" not in out
    assert "source /home/wli7/intel/oneapi/setvars.sh" in out
    assert "conda activate pmg" in out
    assert out.count("srun vasp_std") == 1   # not duplicated


def test_adapt_inserts_missing_directives_after_shebang():
    out = cl.adapt_job_script(
        "#!/bin/bash\nmodule load vasp\nsrun vasp_std\n", job_name="j",
        work_dir="/w", account="a", partition="p", walltime="1:00:00",
        ntasks="8", run_command="srun vasp_std",
    )
    lines = out.splitlines()
    assert lines[0] == "#!/bin/bash"
    for key in ("job-name", "account", "partition", "time", "ntasks"):
        assert any(ln.startswith(f"#SBATCH --{key}=") for ln in lines)
    assert "module load vasp" in out


# ---- squeue interpretation ----

def test_squeue_and_state_mapping():
    assert cl.parse_squeue("RUNNING\n") == "RUNNING"
    assert cl.parse_squeue("") == ""
    assert cl.map_state("RUNNING", True) == "RUNNING"
    assert cl.map_state("CONFIGURING", True) == "PENDING"
    assert cl.map_state("", True) == "DONE"     # left queue
    assert cl.map_state("", False) == "PENDING"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_lib.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'campaign_lib'`

- [ ] **Step 3: Write minimal implementation**

Create `server/catgo/workflow/skills/campaign/scripts/campaign_lib.py` (pure section first):

```python
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
import os
import posixpath
import re
import shlex
import subprocess
import tempfile
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
    "jobid", "submitted_at", "updated_at",
]


@dataclass
class Status:
    state: str = "PENDING"
    cluster: str = ""
    job_type: str = ""
    remote_dir: str = ""
    jobid: str = ""
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
    if not squeue_state:
        return "DONE" if had_jobid else "PENDING"
    return _SQUEUE_MAP.get(squeue_state, squeue_state)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_lib.py -v`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/skills/campaign/scripts/campaign_lib.py \
        server/catgo/workflow/skills/campaign/scripts/test_campaign_lib.py
git commit -m "feat(campaign): campaign_lib pure helpers (naming/status/cluster-gate/jobscript/squeue)"
```

---

### Task 2: `campaign_lib.py` — ssh wrappers + orchestration (scaffold/fetch/submit/poll)

**Files:**
- Modify: `server/catgo/workflow/skills/campaign/scripts/campaign_lib.py` (append)
- Test: `server/catgo/workflow/skills/campaign/scripts/test_campaign_lib.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/catgo/workflow/skills/campaign/scripts/test_campaign_lib.py`:

```python
import pytest


def _good_cluster_md():
    return cl.render_cluster(cl.ClusterConfig(
        cluster="expanse", ssh_host="lab", account="sdp126", partition="shared",
        walltime="12:00:00", ntasks="64", run_command="srun vasp_std",
        load_method="source setvars.sh", potcar_root="/pot",
        python_env="conda activate pmg", remote_base="/remote/base",
    ))


# ---- scaffold ----

def test_scaffold_blank_tree(tmp_path):
    root = cl.scaffold_project(tmp_path / "SAA-HER", "SAA HER", template="blank")
    for f in ("README.md", "INDEX.md", "plan.md", "cluster.md"):
        assert (root / f).is_file()
    for d in cl.SUBDIRS:
        assert (root / d / "INDEX.md").is_file()
    # every md follows the progressive convention
    for md in root.rglob("*.md"):
        t = md.read_text()
        assert t.lstrip().startswith("# ") and "**TL;DR:**" in t
    # freshly scaffolded cluster.md is NOT submittable (must pass setup gate)
    assert not cl.is_submittable(cl.parse_cluster((root / "cluster.md").read_text()))


def test_scaffold_saa_her_seeds_stages(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "SAA HER", template="saa_her")
    assert (root / "calc" / "01-stability-formation-energy" / "INDEX.md").is_file()
    assert (root / "calc" / "02-activity-dGH" / "INDEX.md").is_file()
    assert "decision point" in (root / "plan.md").read_text().lower()


# ---- submit gate (enforced in code, not just SKILL prose) ----

def test_submit_refuses_unconfirmed_cluster(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "INCAR").write_text("ENCUT = 520\n")
    with pytest.raises(cl.CampaignError) as ei:
        cl.submit_calc(str(root), "calc/01-stability-formation-energy/c", "lab")
    assert "cluster.md" in str(ei.value)


def test_submit_refuses_missing_reference_script(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    (root / "cluster.md").write_text(_good_cluster_md())
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "INCAR").write_text("ENCUT = 520\n")
    with pytest.raises(cl.CampaignError) as ei:
        cl.submit_calc(str(root), "calc/01-stability-formation-energy/c", "lab")
    assert "reference_job.sb" in str(ei.value)


# ---- submit / poll / fetch happy paths (stdlib ssh mocked at _run) ----

@pytest.fixture
def _mock_run(monkeypatch):
    calls = []

    def fake_run(argv):
        calls.append(argv)
        joined = " ".join(argv)
        if "sbatch" in joined:
            return 0, "Submitted batch job 55\n", ""
        if "squeue" in joined:
            return 0, "", ""          # gone from queue -> DONE
        return 0, "", ""              # scp / mkdir ok
    monkeypatch.setattr(cl, "_run", fake_run)
    return calls


def test_submit_happy_writes_status_and_ships_inputs(tmp_path, _mock_run):
    root = cl.scaffold_project(tmp_path / "p", "SAA HER", template="saa_her")
    (root / "cluster.md").write_text(_good_cluster_md())
    (root / "scripts" / "reference_job.sb").write_text(
        "#!/bin/bash\n#SBATCH --time=1:00:00\nsource setvars.sh\nsrun vasp_std\n"
    )
    calc = root / "calc" / "01-stability-formation-energy" / "Pt1-Cu_SAA"
    calc.mkdir(parents=True)
    (calc / "INCAR").write_text("ENCUT = 520\n")
    (calc / "POSCAR").write_text("Pt\n1.0\n")

    res = cl.submit_calc(
        str(root), "calc/01-stability-formation-energy/Pt1-Cu_SAA", "lab",
        job_type="vasp geo_opt", now="t0",
    )
    assert res["jobid"] == "55"
    assert res["remote_dir"] == (
        "/remote/base/SAA-HER/calc/01-stability-formation-energy/Pt1-Cu_SAA"
    )
    st = cl.parse_status((calc / "STATUS.md").read_text())
    assert st.state == "RUNNING" and st.jobid == "55"
    # job.sb written locally too (self-describing local tree)
    assert (calc / "job.sb").is_file()
    # inputs + job.sb scp'd; bookkeeping md NOT shipped
    scp_dests = [a[-1] for a in _mock_run if a and a[0] == "scp"]
    names = [d.rsplit("/", 1)[-1] for d in scp_dests]
    assert "INCAR" in names and "POSCAR" in names and "job.sb" in names
    assert "STATUS.md" not in names


def test_poll_marks_finished_done(tmp_path, _mock_run):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "STATUS.md").write_text(cl.render_status(cl.Status(
        title="c", state="RUNNING", cluster="expanse", jobid="55",
        remote_dir="/remote/base/p/calc/01/c",
    )))
    updated = cl.poll_campaign(str(root), "lab", now="t1")
    assert any("RUNNING->DONE" in u for u in updated)
    assert cl.parse_status((calc / "STATUS.md").read_text()).state == "DONE"


def test_fetch_reference_writes_script(tmp_path, monkeypatch):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")

    def fake_run(argv):
        # simulate scp-from by writing to the local dest (last argv element)
        Path(argv[-1]).write_text("#!/bin/bash\nsrun vasp_std\n")
        return 0, "", ""
    monkeypatch.setattr(cl, "_run", fake_run)

    dest = cl.fetch_reference(str(root), "lab", "/expanse/test/vasp_test.sb")
    assert dest.is_file()
    assert "srun vasp_std" in dest.read_text()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_lib.py -v`
Expected: FAIL with `AttributeError: module 'campaign_lib' has no attribute 'scaffold_project'`

- [ ] **Step 3: Write minimal implementation**

Append to `server/catgo/workflow/skills/campaign/scripts/campaign_lib.py`:

```python
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
    return ssh_run(alias, f"squeue -j {shlex.quote(jobid)} -h -o %T")


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


def submit_calc(project, calc_rel: str, alias: str, job_type: str = "",
                now: str | None = None) -> dict:
    """Gate-enforcing submit: refuses an unconfirmed cluster.md or a missing
    reference script (so cluster paths are never guessed), then adapts the
    reference script, scp's the calc inputs, sbatch's, and writes STATUS.md."""
    proj = Path(project).expanduser()
    calc_rel = calc_rel.strip("/")
    local = proj / calc_rel
    if not local.is_dir():
        raise CampaignError(f"calc folder not found: {local}")

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

    use_alias = alias or cfg.ssh_host
    job_name = calc_rel.rsplit("/", 1)[-1]
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
    return {"jobid": jobid, "remote_dir": remote_dir, "job_name": job_name}


def poll_campaign(project, alias: str, now: str | None = None) -> list[str]:
    proj = Path(project).expanduser()
    updated: list[str] = []
    for sf in sorted(proj.glob("calc/**/STATUS.md")):
        st = parse_status(sf.read_text())
        if st.state not in ("PENDING", "RUNNING") or not st.jobid:
            continue
        new_state = map_state(parse_squeue(squeue(alias, st.jobid)), had_jobid=True)
        if new_state != st.state:
            sf.write_text(update_status(
                sf.read_text(), state=new_state, updated_at=now or _utc_now()
            ))
            updated.append(f"{sf.parent.name}: {st.state}->{new_state}")
    return updated
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_campaign_lib.py -v`
Expected: PASS (all Task-1 + 7 new = 19 tests)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/skills/campaign/scripts/campaign_lib.py \
        server/catgo/workflow/skills/campaign/scripts/test_campaign_lib.py
git commit -m "feat(campaign): ssh wrappers + orchestration (scaffold/fetch/submit/poll) with code-enforced gate"
```

---

### Task 3: runnable entrypoint scripts + scripts/INDEX.md

**Files:**
- Create: `server/catgo/workflow/skills/campaign/scripts/new_campaign.py`
- Create: `server/catgo/workflow/skills/campaign/scripts/fetch_ref.py`
- Create: `server/catgo/workflow/skills/campaign/scripts/submit_calc.py`
- Create: `server/catgo/workflow/skills/campaign/scripts/poll.py`
- Create: `server/catgo/workflow/skills/campaign/scripts/INDEX.md`
- Test: `server/catgo/workflow/skills/campaign/scripts/test_entrypoints.py`

- [ ] **Step 1: Write the failing test**

Create `server/catgo/workflow/skills/campaign/scripts/test_entrypoints.py`:

```python
"""Entrypoints are thin: importable, expose main(argv) delegating to campaign_lib."""
import campaign_lib as cl


def test_new_campaign_main_scaffolds(tmp_path, capsys):
    import new_campaign
    rc = new_campaign.main([str(tmp_path / "p"), "--name", "SAA HER",
                            "--template", "saa_her"])
    assert rc == 0
    assert (tmp_path / "p" / "plan.md").is_file()
    assert "created" in capsys.readouterr().out.lower()


def test_submit_main_surfaces_gate_error(tmp_path, capsys):
    import submit_calc
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "INCAR").write_text("ENCUT=520\n")
    rc = submit_calc.main([
        "--project", str(root),
        "--calc", "calc/01-stability-formation-energy/c", "--ssh", "lab",
    ])
    assert rc != 0                       # gate refused
    assert "cluster.md" in capsys.readouterr().err


def test_poll_main_runs_with_no_active(tmp_path):
    import poll
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    rc = poll.main(["--project", str(root), "--ssh", "lab"])
    assert rc == 0                        # nothing active -> no ssh calls -> ok
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_entrypoints.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'new_campaign'`

- [ ] **Step 3: Write minimal implementation**

Create `server/catgo/workflow/skills/campaign/scripts/new_campaign.py`:

```python
#!/usr/bin/env python3
"""Scaffold a md-orchestration campaign project at a user-chosen location.

    python new_campaign.py <dir> [--name "<name>"] [--template blank|saa_her]
"""
from __future__ import annotations

import argparse
import sys

import campaign_lib as cl


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="scaffold a campaign project")
    ap.add_argument("path", help="project directory (any location you choose)")
    ap.add_argument("--name", default="", help="project name (default: dir name)")
    ap.add_argument("--template", default="blank", choices=["blank", "saa_her"])
    args = ap.parse_args(argv)
    name = args.name or cl.Path(args.path).name
    root = cl.scaffold_project(args.path, name, template=args.template)
    print(f"created campaign '{name}' at {root} (template={args.template})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Create `server/catgo/workflow/skills/campaign/scripts/fetch_ref.py`:

```python
#!/usr/bin/env python3
"""Pull a reference job script from the cluster into scripts/reference_job.sb.

    python fetch_ref.py --project <dir> --ssh <alias> --remote_path <cluster .sb>
"""
from __future__ import annotations

import argparse
import sys

import campaign_lib as cl


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="fetch a remote reference job script")
    ap.add_argument("--project", required=True)
    ap.add_argument("--ssh", required=True, help="ssh alias / host")
    ap.add_argument("--remote_path", required=True, help="path to the .sb on the cluster")
    args = ap.parse_args(argv)
    try:
        dest = cl.fetch_reference(args.project, args.ssh, args.remote_path)
    except cl.CampaignError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"fetched reference script -> {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Create `server/catgo/workflow/skills/campaign/scripts/submit_calc.py`:

```python
#!/usr/bin/env python3
"""Submit ONE calc: gate -> adapt reference script -> scp inputs -> ssh sbatch.

    python submit_calc.py --project <dir> --calc calc/<stage>/<candidate> --ssh <alias>

Refuses to submit while cluster.md is unconfirmed or no reference_job.sb exists
(never guess cluster paths). The input-file confirmation is the agent's job
BEFORE calling this — this script performs the already-approved submission.
"""
from __future__ import annotations

import argparse
import sys

import campaign_lib as cl


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="submit one campaign calc")
    ap.add_argument("--project", required=True)
    ap.add_argument("--calc", required=True, help="calc rel path under the project")
    ap.add_argument("--ssh", default="", help="ssh alias (default: cluster.md ssh_host)")
    ap.add_argument("--job_type", default="", help="label, e.g. 'vasp geo_opt'")
    args = ap.parse_args(argv)
    try:
        res = cl.submit_calc(args.project, args.calc, args.ssh, job_type=args.job_type)
    except cl.CampaignError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"submitted {res['job_name']} job={res['jobid']} dir={res['remote_dir']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Create `server/catgo/workflow/skills/campaign/scripts/poll.py`:

```python
#!/usr/bin/env python3
"""Poll all active calcs (squeue) and update their STATUS.md.

    python poll.py --project <dir> --ssh <alias>
"""
from __future__ import annotations

import argparse
import sys

import campaign_lib as cl


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="poll active campaign jobs")
    ap.add_argument("--project", required=True)
    ap.add_argument("--ssh", required=True, help="ssh alias / host")
    args = ap.parse_args(argv)
    try:
        updated = cl.poll_campaign(args.project, args.ssh)
    except cl.CampaignError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print("poll: " + ("; ".join(updated) if updated else "no changes"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Create `server/catgo/workflow/skills/campaign/scripts/INDEX.md`:

```markdown
# campaign scripts

> **TL;DR:** Reference scripts for md-orchestration campaigns. Run them as-is
> (gates enforced) or read `campaign_lib.py` and adapt for the unforeseen.

- `campaign_lib.py` — the library: naming, STATUS.md, cluster.md gate, job-script
  adaptation, squeue, stdlib-ssh wrappers, and the orchestration functions. Read
  this to understand or adapt; the entrypoints below are thin wrappers.
- `new_campaign.py <dir> [--name N] [--template blank|saa_her]` — scaffold a project.
- `fetch_ref.py --project <dir> --ssh <alias> --remote_path <.sb>` — pull a
  reference job script from the cluster.
- `submit_calc.py --project <dir> --calc <rel> --ssh <alias>` — submit ONE calc;
  **refuses** if cluster.md is unconfirmed or reference_job.sb is missing.
- `poll.py --project <dir> --ssh <alias>` — squeue active calcs, update STATUS.md.
- `test_campaign_lib.py` / `test_entrypoints.py` — dev verification (not a CI gate):
  `cd <this dir> && python -m pytest -v`.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_entrypoints.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/skills/campaign/scripts/new_campaign.py \
        server/catgo/workflow/skills/campaign/scripts/fetch_ref.py \
        server/catgo/workflow/skills/campaign/scripts/submit_calc.py \
        server/catgo/workflow/skills/campaign/scripts/poll.py \
        server/catgo/workflow/skills/campaign/scripts/INDEX.md \
        server/catgo/workflow/skills/campaign/scripts/test_entrypoints.py
git commit -m "feat(campaign): runnable entrypoint scripts + scripts INDEX"
```

---

### Task 4: `SKILL.md` + SAA-HER template + structure lint

**Files:**
- Create: `server/catgo/workflow/skills/campaign/SKILL.md`
- Create: `server/catgo/workflow/skills/campaign/templates/saa_her/plan.md`
- Test: `server/catgo/workflow/skills/campaign/scripts/test_skill_structure.py`

- [ ] **Step 1: Write the failing test**

Create `server/catgo/workflow/skills/campaign/scripts/test_skill_structure.py`:

```python
"""The campaign SKILL + template exist and document the gates + conventions."""
from pathlib import Path

_SKILL = Path(__file__).resolve().parents[1]   # .../skills/campaign


def test_skill_md_documents_gates_and_conventions():
    text = (_SKILL / "SKILL.md").read_text()
    low = text.lower()
    assert "input-file gate" in low
    assert "cluster.md" in text
    assert "yolo" in low
    assert "never guess" in low or "do not guess" in low
    assert "STATUS.md" in text
    assert "submit_calc.py" in text     # points the agent at the scripts
    assert "progressive" in low


def test_saa_her_template_has_funnel():
    text = (_SKILL / "templates" / "saa_her" / "plan.md").read_text()
    assert text.lstrip().startswith("# ")
    assert "**TL;DR:**" in text
    assert "decision point" in text.lower()
    assert "dG_H" in text or "ΔG" in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_skill_structure.py -v`
Expected: FAIL with `FileNotFoundError` (SKILL.md missing)

- [ ] **Step 3: Write minimal implementation**

Create `server/catgo/workflow/skills/campaign/SKILL.md`:

```markdown
---
name: campaign-md-orchestration
description: Drive a file-first, agent-in-the-loop computational campaign via a folder + markdown tree (no DB). Use when the user opts out of the visual workflow engine.
---

# Campaign (md-orchestration) — agent playbook

> **TL;DR:** Run multi-step HPC campaigns from a human-readable folder + markdown
> tree. You (the agent) read `plan.md` + `STATUS.md`, render inputs, submit via
> the reference scripts (plain ssh sbatch), update markdown, and check in at
> gates. No DB. Files are the source of truth.

## When to use

The user chose md-orchestration over the visual workflow engine (exploratory /
iterative / mixed-software / cross-cluster work). The visual DB engine still
exists for fixed routines + teaching — don't use this skill for those.

## Conventions (always)

- **Progressive markdown.** Every md opens with `# title` + a `> **TL;DR:**`
  line. Read `INDEX.md` first; drill into a branch only when you work it. Keep
  `STATUS.md` / `LESSONS.md` curated, never append-only logs.
- **README + INDEX pair** at every level (description + pointer).
- **Human-readable names, never hashes** (uniqueness from the path hierarchy; a
  clash gets a `-2` suffix). The remote work_dir mirrors the local tree.
- **Two-level plan.** Project `plan.md` = the campaign (stages / funnel /
  decision points). Each calc folder has its own `plan.md` = that calc's recipe
  (method, params + literature citation, convergence, restart strategy, result
  to extract, dependencies).

## Setup gate — confirm the environment (NEVER guess)

Before submitting anything, confirm with the user and record in `cluster.md`:
cluster identity + SSH host/account + partition/walltime/ntasks, the compute
binary + load method (module/conda/full path + run command), the POTCAR root,
the python env, and the remote base dir. The user may give a reference job
script — local, or **a path on the cluster** (pull it with `fetch_ref.py`);
CatGO adapts it instead of synthesizing the preamble. Run `catgo_validate_config`
before the first submit. `submit_calc.py` **refuses** while `cluster.md` is
incomplete — this is enforced in code, not just here. Never guess cluster paths.

## Gates (default human-in-the-loop)

1. **Input-file gate (per submission).** Before each `submit_calc.py`, show the
   user the rendered `INCAR`/`POSCAR`/`KPOINTS`/`POTCAR`/`job.sb` and ask to
   confirm. Run the script only after they confirm.
2. **Stage / decision-point checkpoint.** At a stage end or a `plan.md` decision
   point, write a stage summary and ask: proceed / modify / stop.

**YOLO / autopilot opt-in** disables both gates. Set it only if the user says so
per-run ("go as you set" / "yolo") or persistently ("always skip review"). With
YOLO off and the user away, hold at the gate: keep polling running jobs but
submit nothing new and cross no stage.

## The loop (human-triggered, ~10 min, configurable)

Keep your working context lean (just `plan.md` + the active `STATUS.md`). Each wake:

1. Read `plan.md` + active `STATUS.md`.
2. `python poll.py --project <dir> --ssh <alias>` (updates STATUS via squeue).
3. For finished calcs: collect results into `result.md`; note gotchas in `LESSONS.md`.
4. Render inputs for newly-ready calcs -> input-file gate -> `submit_calc.py`.
5. At a stage/decision point -> write a summary -> checkpoint.
6. On an unhandleable problem -> write it to STATUS/LESSONS and stop.

## Scripts (in `scripts/`, see scripts/INDEX.md)

```
python new_campaign.py <dir> --name "<name>" --template saa_her|blank
python fetch_ref.py   --project <dir> --ssh <alias> --remote_path <cluster .sb>
python submit_calc.py --project <dir> --calc calc/<stage>/<candidate> --ssh <alias>
python poll.py        --project <dir> --ssh <alias>
```

Run them as-is (gates enforced), or read `scripts/campaign_lib.py` and adapt for
the unforeseen (mixed software / odd clusters / novel calc types).

## Literature -> plan -> skill

Drop papers (PDF -> MinerU md) + GitHub repos into `literature/`; ground `plan.md`
in them with citations. Mine reusable recipes into `literature/extracted-skills.md`;
promote the best into the global SKILL library.
```

Create `server/catgo/workflow/skills/campaign/templates/saa_her/plan.md`:

```markdown
# SAA HER screening — plan

> **TL;DR:** Single-atom-alloy HER screening funnel: stability (E_form) -> activity
> (ΔG_H*) -> analysis. Each stage has a decision point; stage 2 only expands stage
> 1 survivors.

## Stages

1. **Stability — formation energy** (`calc/01-stability-formation-energy/`)
   Per candidate SAA slab: geo_opt -> energy -> E_form.
   **decision point:** keep candidates with E_form below the user-set threshold.

2. **Activity — ΔG_H\*** (`calc/02-activity-dGH/`)
   Per survivor: clean slab + *H slab -> geo_opt -> freq -> gibbs -> ΔG_H*.
   **decision point:** rank by |ΔG_H*|; report the top candidates.

3. **Analysis** (`analysis/`)
   E_form ranking + ΔG_H* volcano + funnel summary (P2 aggregation).

## Shared references (`refs/`)

H2 molecule + clean host slab — computed once, reused by every candidate.

## Per-calc recipe

Each candidate folder gets its own `plan.md` (method, params + citation,
convergence, restart strategy, result to extract, dependencies).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_skill_structure.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/skills/campaign/SKILL.md \
        server/catgo/workflow/skills/campaign/templates/saa_her/plan.md \
        server/catgo/workflow/skills/campaign/scripts/test_skill_structure.py
git commit -m "feat(campaign): SKILL playbook + SAA-HER template"
```

---

### Task 5: full suite + end-to-end sanity

**Files:** none (verification only)

- [ ] **Step 1: Run the whole campaign script suite**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest -v`
Expected: PASS (test_campaign_lib 19 + test_entrypoints 3 + test_skill_structure 2 = 24).

- [ ] **Step 2: Sanity-run the scaffolder + show the tree**

Run:
```bash
cd server/catgo/workflow/skills/campaign/scripts && \
/home/james0001/miniforge3/envs/catgo/bin/python new_campaign.py \
  /tmp/SAA-HER-demo --name "SAA HER" --template saa_her && \
find /tmp/SAA-HER-demo -type f | sort
```
Expected: prints the readable tree — README/INDEX/plan/cluster at top, each of
literature/refs/scripts/calc/analysis/report/archive with INDEX.md, plus the two
calc stage folders' INDEX.md. (Then `rm -rf /tmp/SAA-HER-demo`.)

- [ ] **Step 3: Confirm the gate refuses a guessed submit**

Run:
```bash
cd server/catgo/workflow/skills/campaign/scripts && \
/home/james0001/miniforge3/envs/catgo/bin/python submit_calc.py \
  --project /tmp/SAA-HER-demo2 --calc calc/01-stability-formation-energy/x --ssh lab; \
echo "exit=$?"
```
First scaffold `/tmp/SAA-HER-demo2` via new_campaign.py and create the empty calc
dir, then run the above. Expected: nonzero exit + a message naming `cluster.md`
(the env gate refuses). (Then `rm -rf /tmp/SAA-HER-demo2`.)

---

## Self-Review

**1. Spec coverage** (spec → task):
- md-orchestration tree + scaffolder → Task 2 (`scaffold_project`) + Task 3 (`new_campaign.py`). ✓
- Progressive markdown convention → `tldr_header` (Task 1), enforced in scaffold (Task 2) + lint (Tasks 2/4). ✓
- STATUS.md durable cursor → Task 1 (Status) + used in Task 2 (submit/poll). ✓
- cluster.md env gate, cluster identity/job params, never-guess → Task 1 (`ClusterConfig`/`missing_fields`) + Task 2 (`submit_calc` hard refuse) + SKILL (Task 4). ✓
- Reference job script (local or remote path) + adaptation → Task 1 (`adapt_job_script`) + Task 2 (`fetch_reference`/`submit_calc`) + Task 3 (`fetch_ref.py`). ✓
- Remote mirrors readable tree, no hash, plain ssh sbatch → Task 1 (`remote_mirror_path`) + Task 2 (ssh wrappers / `submit_calc`). ✓
- Input-file gate + checkpoints + YOLO → SKILL (Task 4); the input-file confirm is conversational, the env gate is code-enforced. ✓
- Two-level plan, loop (~10 min, lean context), literature flow → SKILL (Task 4); `poll.py` is the loop's per-wake action (Task 3). ✓
- analysis aggregation / report / archive automation / mode-selection GUI / MinerU ingestion → **P2** (separate plan, per spec phasing). Intentional gaps.

**2. Placeholder scan:** No "TBD/TODO" in the plan. Every code step shows complete code; every command shows expected output. `<fill in>` strings appear only inside *generated* README/cluster stubs (runtime artifacts the user fills), not as plan placeholders. ✓

**3. Type consistency:** All callers use the single module `campaign_lib` (`cl.*`); `Status`/`ClusterConfig` field names are defined once and reused; `adapt_job_script` keyword args match its call in `submit_calc`; `remote_mirror_path(remote_base, project_name, rel_path)` matches its one call site; ssh wrappers (`_run`/`ssh_run`/`scp_to`/`scp_from`/`sbatch`/`squeue`) are monkeypatched at the single `_run` seam in tests; entrypoints all expose `main(argv)->int`. ✓
```
