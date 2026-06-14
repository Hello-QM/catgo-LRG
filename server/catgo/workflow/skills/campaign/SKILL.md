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

## Conventions

Authoring conventions (progressive md, README+INDEX pairs + keeping them current, logging
interventions to LESSONS, human-readable/never-hash names, the top→stage→calc progressive
plan, filling scaffold stubs) live in the **`catgo-campaign-conventions`** skill — follow
it whenever you create/edit campaign markdown.

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

**Derive the full pipeline from the TARGET OBSERVABLE — before building ANY input.**
Work backward from what the user wants to measure to every calc it requires, and write
that into `plan.md` BEFORE scaffolding structures/inputs (the build order is: plan first,
inputs second). Common traps:
- **Overpotential / free-energy diagram / ΔG / Gibbs / adsorption *free* energy** ⇒ needs
  free energies, not raw DFT energies ⇒ **follow the `catgo-gibbs-pipeline` skill** (the
  per-species `geo_opt → freq → gibbs` pipeline, freq setup, gas-ref convention, CHE, η).
  Wire freq as the auto-next-step after each species' geo_opt in `plan.md`.
- **Reaction barriers / TS** ⇒ NEB/dimer + a freq to confirm one imaginary mode.
- **Band gap / DOS / COHP** ⇒ a dense-k static after relax.
Confirm the full stage list with the user before building. Do NOT jump from "scope" to
rendering inputs — discuss the plan (and its observables) first.

## The loop + resuming

Driving the ~10-min poll loop (delegate each poll to a subagent → compact summary; verify
convergence by **force**; auto-advance each converged species per-species, pipeline not
barrier; stage checkpoints) AND resuming a campaign from disk after compaction / a new
session live in the **`catgo-campaign-loop`** skill. Gates stay with the main agent.

## Scripts (in `scripts/`, see scripts/INDEX.md)

```
python new_campaign.py <dir> --name "<name>" --template saa_her|blank
python fetch_ref.py   --project <dir> --ssh <alias> --remote_path <cluster .sb>
python submit_calc.py --project <dir> --calc calc/<stage>/<candidate> --ssh <alias>
python poll.py        --project <dir> --ssh <alias>
```

Run them as-is (gates enforced), or read `scripts/campaign_lib.py` and adapt for
the unforeseen (mixed software / odd clusters / novel calc types).

## Archiving (explicit / propose — never auto-decide)

Keep the live tree clean by moving superseded/abandoned calcs into `archive/`, but
NEVER guess what is stale: `python archive.py --project <dir> --list` proposes only
`STATUS=FAILED` calcs (it does not move anything). **Funnel rejects (a DONE calc with a
high E_form) are kept** — the ranking/volcano/funnel need them as data. Move one only on
explicit user instruction: `python archive.py --project <dir> --calc calc/<stage>/<name>
--reason "..."` (leaves a tombstone `ARCHIVED.md` at the original location).

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
