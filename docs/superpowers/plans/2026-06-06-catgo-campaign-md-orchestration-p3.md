# CatGO Campaign md-orchestration — P3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the campaign flow (1) ask the user whether to brainstorm the plan first, (2) launchable from any directory via a `catgo campaign` console subcommand, and (3) discoverable by Claude Code anywhere via a global personal skill.

**Architecture:** Task 1 edits the in-repo campaign `SKILL.md` (a brainstorm-or-direct choice gate before `plan.md`). Task 2 adds a thin `catgo campaign` launcher (`catgo/cli/campaign_cmd.py`) wired into the existing argparse in `catgo/cli/__init__.py`; it locates the campaign reference scripts shipped inside the `catgo` package and dispatches to their `main(argv)` — logic stays skill-first in `campaign_lib`. Task 3 creates `~/.claude/skills/catgo-campaign/SKILL.md` (global personal skill) that points the agent at `catgo campaign`.

**Tech Stack:** Python 3.11 stdlib, pytest. No new deps.

**Spec/prior:** specs/2026-06-06-...-design.md; plans `...-mvp.md` + `...-p2.md` (already shipped on this branch).

**Gotchas:**
- catgo python: `/home/james0001/miniforge3/envs/catgo/bin/python`.
- Do NOT push (private repo). Do NOT touch `:8000`. Do NOT `deno fmt`.
- Task 1/2 tests run from `server/`: `cd server && <catgo py> -m pytest tests/cli/test_campaign_cmd.py -v` (catgo.cli imports need the package, so run from `server/`, NOT the scripts dir).
- The campaign script structure-lint test still runs from the scripts dir.

---

### Task 1: SKILL.md — ask user "brainstorm or direct" before plan.md

**Files:**
- Modify: `server/catgo/workflow/skills/campaign/SKILL.md`
- Test: `server/catgo/workflow/skills/campaign/scripts/test_skill_structure.py` (append)

- [ ] **Step 1: Write the failing test** — append to `test_skill_structure.py`:

```python
def test_skill_md_offers_brainstorm_choice():
    text = (_SKILL / "SKILL.md").read_text()
    low = text.lower()
    assert "brainstorm" in low
    # the agent must ASK the user how to create the plan, not assume
    assert "ask the user" in low or "ask first" in low
    assert "plan.md" in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_skill_structure.py -k brainstorm -v`
Expected: FAIL (SKILL.md has no brainstorm-choice section yet).

- [ ] **Step 3: Write minimal implementation**

In `server/catgo/workflow/skills/campaign/SKILL.md`, insert this section immediately
before the `## The loop` section (the line that starts `## The loop`):

```
## Plan creation — ask the user first

Before writing or finalizing `plan.md`, ASK the user how to create it — do not assume:

- **Brainstorm together** — read `literature/INDEX.md` first, then ask clarifying
  questions ONE at a time (goal, candidate set, descriptor, funnel thresholds,
  reference systems), propose 2-3 stage / decision-point approaches with a
  recommendation, and write `plan.md` only after the user approves.
- **Template / direct** — instantiate a template (e.g. `saa_her`) or generate
  `plan.md` from the user's stated intent, then let them review and edit it.

Default to asking. Skip the question only if the user already opted in
("just use the template" / "go as you set" / YOLO).

```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/catgo/workflow/skills/campaign/scripts && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest test_skill_structure.py -v`
Expected: PASS (existing 4 + 1 new = 5).

- [ ] **Step 5: Commit**

```bash
git add server/catgo/workflow/skills/campaign/SKILL.md \
        server/catgo/workflow/skills/campaign/scripts/test_skill_structure.py
git commit -m "feat(campaign): ask user to brainstorm-or-direct before writing plan.md"
```

---

### Task 2: `catgo campaign` console subcommand

**Files:**
- Create: `server/catgo/cli/campaign_cmd.py`
- Modify: `server/catgo/cli/__init__.py`
- Test: `server/tests/cli/test_campaign_cmd.py`

- [ ] **Step 1: Write the failing test** — create `server/tests/cli/test_campaign_cmd.py`:

```python
"""`catgo campaign ...` portable launcher (dispatches to the skill scripts)."""
from catgo.cli.campaign_cmd import run_campaign, _scripts_dir


def test_scripts_dir_points_at_shipped_scripts():
    assert (_scripts_dir() / "new_campaign.py").is_file()
    assert (_scripts_dir() / "campaign_lib.py").is_file()


def test_campaign_new_scaffolds(tmp_path):
    rc = run_campaign(["new", str(tmp_path / "p"), "--name", "SAA HER",
                       "--template", "saa_her"])
    assert rc == 0
    assert (tmp_path / "p" / "plan.md").is_file()
    assert (tmp_path / "p" / "calc" / "02-activity-dGH" / "INDEX.md").is_file()


def test_unknown_action_errors(capsys):
    rc = run_campaign(["bogus"])
    assert rc == 2
    assert "unknown campaign action" in capsys.readouterr().err


def test_no_args_prints_usage(capsys):
    rc = run_campaign([])
    assert rc == 2
    assert "usage" in capsys.readouterr().out.lower()


def test_parser_wires_campaign_remainder():
    from catgo.cli import _build_legacy_parser
    parser, _ = _build_legacy_parser()
    args = parser.parse_args(["campaign", "poll", "--project", "x", "--ssh", "y"])
    assert args.command == "campaign"
    assert args.rest == ["poll", "--project", "x", "--ssh", "y"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/cli/test_campaign_cmd.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'catgo.cli.campaign_cmd'`

- [ ] **Step 3: Write minimal implementation**

Create `server/catgo/cli/campaign_cmd.py`:

```python
"""`catgo campaign ...` — portable launcher for the md-orchestration campaign.

Thin launcher only: it locates the campaign reference scripts shipped inside the
catgo package and dispatches to their ``main(argv)``. All logic stays in those
scripts (skill-first); this just makes them runnable from any directory where
``catgo`` is on PATH.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

# action -> entrypoint module name (in the campaign scripts dir)
_ACTIONS = {
    "new": "new_campaign",
    "fetch-ref": "fetch_ref",
    "submit": "submit_calc",
    "poll": "poll",
    "aggregate": "aggregate",
    "report": "make_report",
    "ingest": "ingest_lit",
}

_USAGE = "usage: catgo campaign {" + "|".join(_ACTIONS) + "} [args]"


def _scripts_dir() -> Path:
    import catgo
    return (Path(catgo.__file__).resolve().parent
            / "workflow" / "skills" / "campaign" / "scripts")


def run_campaign(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(_USAGE)
        return 0 if argv else 2
    action, rest = argv[0], argv[1:]
    module = _ACTIONS.get(action)
    if module is None:
        print(f"error: unknown campaign action '{action}'", file=sys.stderr)
        print(_USAGE, file=sys.stderr)
        return 2
    scripts = str(_scripts_dir())
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    mod = importlib.import_module(module)
    return int(mod.main(rest) or 0)


def cmd_campaign(args) -> None:
    """argparse hook: `catgo campaign <rest...>`."""
    raise SystemExit(run_campaign(list(getattr(args, "rest", []) or [])))
```

In `server/catgo/cli/__init__.py`, inside `_build_legacy_parser()`, after the
`p_stop` block (the lines defining `p_stop` + its `set_defaults`) and before
`return parser, sub`, add:

```python
    from catgo.cli.campaign_cmd import cmd_campaign
    p_campaign = sub.add_parser(
        "campaign",
        help="md-orchestration campaign (file-first, agent-driven)")
    p_campaign.add_argument(
        "rest", nargs=argparse.REMAINDER,
        help="<action> [args]: new|fetch-ref|submit|poll|aggregate|report|ingest")
    p_campaign.set_defaults(func=cmd_campaign)
```

(`argparse` is already imported at the top of `_build_legacy_parser`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/cli/test_campaign_cmd.py -v`
Expected: PASS (5 tests). Also run `tests/cli/test_argparse.py` to confirm no regression:
`cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/cli/test_argparse.py -v`

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/campaign_cmd.py server/catgo/cli/__init__.py \
        server/tests/cli/test_campaign_cmd.py
git commit -m "feat(campaign): catgo campaign console subcommand (portable launcher)"
```

---

### Task 3: global Claude Code skill `~/.claude/skills/catgo-campaign/`

This file lives in the user's `~/.claude` (NOT the repo) so Claude Code discovers it
from any directory. It is markdown only (no test, no repo commit).

- [ ] **Step 1: Create the global skill**

Create `~/.claude/skills/catgo-campaign/SKILL.md`:

```markdown
---
name: catgo-campaign
description: Run a CatGo file-first md-orchestration "campaign" — a multi-step / high-throughput computational-materials study (e.g. SAA HER screening) driven from a human-readable folder + markdown tree, not the DB workflow engine. Use when the user says "跑一个 campaign", "md 模式跑", "high-throughput screening", or wants an agent-in-the-loop study with stages/funnel/analysis/report. Requires `catgo` on PATH.
---

# catgo-campaign — run a file-first computational campaign

A "campaign" = a coordinated multi-step study (many calculations → analysis → report)
toward one research goal. This skill drives it via the portable `catgo campaign` CLI,
which dispatches to CatGo's campaign reference scripts.

## Before anything: confirm the environment (NEVER guess)
Ask the user and record in `cluster.md`: which cluster + SSH host/account +
partition/walltime/ntasks, the compute binary + load method (module/conda/full path +
run command), the POTCAR/pseudopotential root, the python env, and the remote base dir.
The user may give a reference job script (local or a path on the cluster — pull it with
`catgo campaign fetch-ref`). `catgo campaign submit` REFUSES until `cluster.md` is
complete. A wrong path fails every job — if unsure, STOP and ask.

## Steps
1. **Scaffold** at the user's chosen location:
   `catgo campaign new /path/to/Project --name "<name>" --template saa_her|blank`
2. **Plan** — ASK the user: brainstorm the plan together (literature-grounded, one
   question at a time, propose approaches) OR use the template / generate directly.
3. **Reference script** (optional): `catgo campaign fetch-ref --project <dir> --ssh <alias> --remote_path <.sb>`
4. **Per calc**: build inputs (catgo slab/convert/… into the calc folder), SHOW the
   rendered inputs to the user (input-file gate), then
   `catgo campaign submit --project <dir> --calc calc/<stage>/<candidate> --ssh <alias>`
   (skip the gate only on explicit YOLO opt-in).
5. **Loop** (~10 min, user-triggered): `catgo campaign poll --project <dir> --ssh <alias>`
   marks DONE/FAILED via squeue→sacct. A scheduler DONE != converged — open the
   work_dir outputs to confirm, write numbers into the calc's `result.md`, log gotchas
   in `LESSONS.md`.
6. **At a stage / decision point**: `catgo campaign aggregate --project <dir> --plot`
   (ranking / volcano / funnel), then checkpoint with the user.
7. **Report**: `catgo campaign report --project <dir> --occasion groupmeeting`
8. **Literature**: `catgo campaign ingest --project <dir> --pdf <p.pdf>` (MinerU) or
   `--repo <url> --purpose "…"`.

## Notes
- Default to a review gate (user-in-the-loop); only auto-advance on explicit opt-in.
- Full conventions live in the in-repo skill `server/catgo/workflow/skills/campaign/SKILL.md`
  (read it for the folder layout, progressive-md rules, two-level plan, gate details).
```

- [ ] **Step 2: Verify discovery + the CLI it points at**

Run: `ls ~/.claude/skills/catgo-campaign/SKILL.md && catgo campaign 2>&1 | head -1`
Expected: the file exists; `catgo campaign` prints the usage line. (If `catgo` is not on
PATH, note that the global skill still documents the flow but the user must install/locate
catgo.)

---

### Task 4: full verification

- [ ] **Step 1: Run the campaign + cli suites**

Run:
```
cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest \
  catgo/workflow/skills/campaign/scripts tests/cli/test_campaign_cmd.py tests/cli/test_argparse.py -v
```
Expected: all green (campaign scripts ~48 + new cli tests, no argparse regression).

- [ ] **Step 2: End-to-end via the new subcommand from a non-repo cwd**

Run:
```
cd /tmp && rm -rf /tmp/camp-p3 && \
catgo campaign new /tmp/camp-p3 --name "SAA HER" --template saa_her && \
test -f /tmp/camp-p3/plan.md && echo "OK new from /tmp" && \
catgo campaign 2>&1 | grep -q usage && echo "OK usage" && \
rm -rf /tmp/camp-p3
```
Expected: scaffolds from `/tmp` (proves portability), prints OK lines.

---

## Self-Review

**1. Coverage:** brainstorm-or-direct ask → Task 1 (SKILL + test). Portable launcher → Task 2 (`catgo campaign` subcommand + tests, REMAINDER wiring). Global discovery → Task 3 (`~/.claude/skills/catgo-campaign/SKILL.md`). ✓

**2. Placeholders:** none; complete code/markdown + exact commands. `<name>`/`<dir>`/`<alias>` appear only inside CLI usage templates the user fills at runtime. ✓

**3. Consistency:** `run_campaign`/`_scripts_dir`/`cmd_campaign` signatures match the test + the `__init__.py` wiring; `_ACTIONS` keys match the global skill's documented `catgo campaign <action>` invocations and the real entrypoint module names (new_campaign/fetch_ref/submit_calc/poll/aggregate/make_report/ingest_lit), each exposing `main(argv)->int`. The argparse `rest=REMAINDER` flows into `cmd_campaign` → `run_campaign`. ✓
```
