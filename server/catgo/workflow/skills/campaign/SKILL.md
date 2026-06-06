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
2. `python poll.py --project <dir> --ssh <alias>` — updates each STATUS.md: while
   queued via `squeue`; once a job leaves the queue, `sacct` decides the terminal
   state (`COMPLETED` -> DONE, `FAILED`/`TIMEOUT`/`OUT_OF_MEMORY`/`CANCELLED`/... ->
   FAILED, with the `exit_code` recorded).
3. For finished calcs: **a scheduler `DONE` is not "the science succeeded"** — the
   batch script can exit 0 while the calc never converged. ALWAYS open the
   `remote_dir` outputs to confirm (e.g. `catgo freq` for Gibbs/ΔG, `catgo dos`/
   `band`/`cohp` — see references/catgo-cli.md), write the numbers into the calc's
   `result.md`, and on a real failure (DONE-but-not-converged, or FAILED) record
   the cause + fix in `LESSONS.md`.
4. Render inputs for newly-ready calcs (build with `catgo slab`/`supercell` etc.)
   -> input-file gate -> `submit_calc.py`.
5. At a stage/decision point -> `python aggregate.py --project <dir> --plot`
   (ranking / volcano / funnel into analysis/) -> write a summary -> checkpoint.
6. For a group meeting: `python make_report.py --project <dir> --occasion groupmeeting`.
7. On an unhandleable problem -> write it to STATUS/LESSONS and stop.

## Scripts (in `scripts/`, see scripts/INDEX.md)

```
python new_campaign.py <dir> --name "<name>" --template saa_her|blank
python fetch_ref.py   --project <dir> --ssh <alias> --remote_path <cluster .sb>
python submit_calc.py --project <dir> --calc calc/<stage>/<candidate> --ssh <alias>
python poll.py        --project <dir> --ssh <alias>
```

Run them as-is (gates enforced), or read `scripts/campaign_lib.py` and adapt for
the unforeseen (mixed software / odd clusters / novel calc types).

## catgo CLI during a campaign

Use the existing `catgo` CLI for the actual chemistry — see
`references/catgo-cli.md`. Build structures (`catgo slab`/`supercell`/`reticular`/
`convert`/`inspect`) and analyze results (`catgo dos`/`band`/`cohp`/`freq`). These
run offline (no viewer needed). Aggregate per-calc `result.md` files with
`scripts/aggregate.py`; draft reports with `scripts/make_report.py`; ingest
literature with `scripts/ingest_lit.py`.

## Literature -> plan -> skill

Drop papers (PDF -> MinerU md) + GitHub repos into `literature/`; ground `plan.md`
in them with citations. Mine reusable recipes into `literature/extracted-skills.md`;
promote the best into the global SKILL library.
