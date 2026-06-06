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
- **README + INDEX pair** at every level (description + pointer). **When you add a
  stage or calc folder, update the parent `INDEX.md`** to list it (one line + role) —
  INDEX is the navigation spine, keep it current; an empty/stale INDEX breaks drill-down.
- **Log every intervention.** Any time you cancel / rebuild / retry a calc, change its
  inputs, or hit a gotcha, record what changed and **why** in that calc's `LESSONS.md`
  (and the project `LESSONS.md` if it generalizes). `STATUS.md` only holds the CURRENT
  job — it does not remember a prior cancelled/failed attempt, so the history lives in
  LESSONS. (`catgo campaign submit` updates STATUS.md automatically; LESSONS is on you.)
- **Human-readable names, never hashes** (uniqueness from the path hierarchy; a
  clash gets a `-2` suffix). The remote work_dir mirrors the local tree.
- **Progressive plan (drill down for detail).** The top `plan.md` says only WHAT —
  goal + the stage list, each line LINKING to that stage's plan — not the how. Each
  stage folder (`calc/<stage>/plan.md`) gives mid-level detail + links to its calcs.
  Each calc folder (`calc/<stage>/<calc>/plan.md`) holds the FULL recipe (method,
  params + rationale, convergence, freq/restart strategy, result to extract,
  dependencies). Keep the top short; push specifics down. (For a flat campaign with no
  stages, two levels — top + per-calc — suffice.)

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
  **free energies, not raw DFT energies** ⇒ the plan MUST include **freq (ZPE + TΔS)**
  calcs for adsorbates (IBRION=5, adsorbate atoms free) AND **gas-phase thermo**
  (`catgo freq --mode gas`) for molecular references. geo_opt energies alone are wrong.
- **Reaction barriers / TS** ⇒ NEB/dimer + a freq to confirm one imaginary mode.
- **Band gap / DOS / COHP** ⇒ a dense-k static after relax.
Confirm the full stage list with the user before building. Do NOT jump from "scope" to
rendering inputs — discuss the plan (and its observables) first.

## Gas-phase references (convention)
Small-molecule gas references (H2, H2O, O2, CO, …): use **Γ-point only** (KPOINTS 1×1×1) +
the **gamma VASP build (`vasp_gam`)** on a **`shared`** node (~32 cores) — never burn an
exclusive 128-core `compute` node on a few-atom molecule. Slabs use `vasp_std` + a k-mesh
on `compute`. Keep a separate gas job template (e.g. `scripts/reference_gas.sb`) since
cluster.md holds the slab config; submit gas via the ssh helpers with that template.

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
