# CatGO Campaign (md-orchestration mode) — Design

**Date:** 2026-06-06
**Status:** Approved (design); ready for implementation planning
**Author:** brainstormed with user (gul026)

---

## Summary / Goal

Add a second, **file-first** way to run multi-step computational-materials campaigns in
CatGO, chosen per-project at creation time:

- **Visual mode** — the existing DB-backed workflow engine (node graph, GUI). Unchanged.
- **md-orchestration mode** — a lightweight, human-readable **folder + markdown** tree
  that an **agent-in-the-loop** drives by reading/writing markdown. No DB row for state;
  the filesystem *is* the source of truth.

md-mode targets the way real research actually happens: exploratory, iterative, mixed
software, no fixed node schema, sometimes spanning multiple clusters, with the human
deeply in the loop (read/edit files in the CatGO client or vim). The DB engine stays for
fixed, repeatable pipelines and teaching/demo.

## Motivation / Problem

The current V2 engine stores all workflow state in a single SQLite DB
(`~/.catgo/catgo.db`: `tasks` / `task_links` / `task_results`). That is the right choice
for an **unattended scheduler** (atomic state transitions, DAG queries, crash safety),
but it has real costs for interactive research:

1. **Opaque to humans.** SQLite is a binary blob; you need a tool to look at it. A
   researcher cannot `vim`/`grep`/`cat` their workflow.
2. **Rigid schema.** Every software/calc type needs a predefined node + schema before it
   can be visualized or run. Mixed / novel / cross-cluster calculations don't fit; the
   schema is "written too hard" (写得很死) to cover what comes up mid-campaign.
3. **Visualization is overhead.** Constructing the viz/node structure itself costs tokens,
   and is only worth it for very fixed routines or teaching.
4. **Agents are file-native.** Claude/agents introspect with `Read`/`Grep`/`Glob` far more
   naturally than SQL-through-MCP. A markdown tree is directly inspectable and editable by
   both human and agent.

**Key insight:** the DB earned its place only via the *unattended daemon scheduler*. This
user's workflow is **agent-in-the-loop**, not fire-and-forget. Remove the daemon and the
DB's main justification goes with it — the durable state it held (job status, remote
addresses, job type) can live in human-readable markdown instead, with no loss for this
mode. This is the same review-gate / human-in-the-loop philosophy established earlier
(default `auto_submit: false`), taken to its conclusion.

This is **not** a replacement of the DB engine. The two modes coexist.

## Design decisions (locked, with rationale)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Two modes, chosen at project creation** | Visualization only pays off for fixed routines / teaching; otherwise it is pure overhead. Let the user opt out and get the lightweight md flow. |
| 2 | **Advancement = human-triggered agent loop** (`~10 min` default wake, user-configurable) | No heavy daemon. The agent, while looping, steps through the playbook autonomously; it only stops on a problem it cannot handle. Human can take over / interrupt anytime. Per-wake cost is small if the loop context is kept lean. |
| 3 | **Playbook = B1 + B2 hybrid** (template library + on-the-fly generation), output is an editable `plan.md` | Common campaigns (SAA HER, ORR, defect formation energy…) instantiate from a template; novel ones are generated from intent. Both produce the same `plan.md` a human can `vim`. The playbook sits **above** the existing per-software SKILLs and calls down into them. |
| 4 | **Two-level gating, default wait-for-human; `YOLO`/`autopilot` opt-in** — (a) per-submission **input-file gate**: agent shows the rendered inputs and asks to confirm before every `ssh sbatch`; (b) **stage/decision-point checkpoints** (C2 + C3: milestones + explicit `decision point`s in `plan.md`) | The input gate is the md-mode form of `auto_submit: false` / `PENDING_REVIEW` — never submit without confirmation. At a stage/decision point the agent writes a summary and pauses (proceed/modify/stop). When the human is away the loop holds (keeps polling running jobs, submits nothing new, crosses no stage) unless `YOLO` is set, which submits + crosses using pre-set `plan.md` criteria. |
| 5 | **State lives in markdown, not DB**; DB is bypassed in md-mode | `STATUS.md` per calc is the durable cursor that DB rows used to be. A fresh agent session reconstructs everything by reading `STATUS.md` + `squeue`. |
| 6 | **Progressive markdown** is a global convention | TL;DR-first, hierarchical INDEX navigation, drill down only the needed branch — keeps every wake/read cheap (token-frugal). |
| 7 | **Literature/knowledge base per project** | Plans and brainstorming are grounded in real papers + reference GitHub repos, not invented. Also a source for extracting reusable skills. |
| 8 | **Per-project location is user-chosen** | Projects are not forced under `~/.catgo`; the user picks where the campaign folder lives. |
| 9 | **Remote mirrors the local tree; human-readable folder names everywhere (no hashes); submit via plain `ssh … sbatch`** | The HPC `work_dir` reproduces the same readable `project/stage/candidate` folders, so `ssh`-ing in and running `ls` is just as clear as the local tree. Uniqueness comes from the path hierarchy, not a `{workflow_id}:{node_id}` hash — a deliberate contrast with the DB engine's namespaced work_dirs (#227, which also caused the colon-in-path bug). Submission stays simple: `ssh <cluster> "cd <remote> && sbatch <job>.sb"` (or `scp` inputs then `ssh sbatch`); no heavy abstraction. |
| 10 | **Confirm-the-environment setup gate — never guess cluster specifics** | Before any submission the agent must confirm with the user and record (in `cluster.md`): the **target cluster + connection + job params** (which cluster — Expanse / Shaheen / local —, SSH host/account, partition, walltime, ntasks), the **compute binary + how it is loaded** (module / conda / full path + run command), the **POTCAR / pseudopotential root**, the **python environment** (conda env / venv / module, for post-processing), and the **remote compute base directory**. The user may hand a **reference job script** — a local file **or a path on the cluster** (fetched via `scp`/`ssh cat`) — which CatGO **adapts** (substitute structure/paths/resources) instead of generating from scratch. Validate with `catgo_validate_config` before the first submit. This is the md-mode form of `feedback_potcar_uncertainty_gate` / SKILL policy 5 — a wrong path/module fails every job and is per-user/per-cluster. |

## Architecture

### Mode selection (project creation)

At project creation the user is asked: *visualize this workflow?* with the trade-offs
shown (below). Choosing **visual** → existing DB engine. Choosing **md** → scaffold the
campaign folder tree (below) at a **user-chosen location**, seeding `README.md`,
`INDEX.md`, and `plan.md` from a template (B1) or generated from intent (B2).

**Visual mode** — pros: standard/repeated flows, whole-DAG-at-a-glance, click-to-run, low
barrier, good for teaching/demo and large homogeneous batch progress overviews. Cons:
every software/calc needs a predefined node+schema (mixed/novel/cross-cluster don't fit);
building the viz structure costs tokens; mid-campaign changes (add a step / switch
cluster) require editing node definitions; state locked in DB (not vim/grep-able); poor
fit for exploratory iteration.

**md-orchestration mode** — pros: any software / mixed / cross-cluster with zero
predefinition; human-readable & editable (vim / CatGO client) and agent-native
(Read/Grep); progressive loading saves tokens; built-in experience capture
(`LESSONS.md`); iteration-friendly. Cons: no whole-campaign picture unless explicitly
rendered; consistency relies on conventions (not schema) → needs good templates/SKILL to
hold the line; cross-workflow aggregation (volcano/funnel) must be done by the agent, not
automatic.

### Folder layout (md-mode)

```
<project>/                       # user-chosen location
  README.md      # what the project is / goal / current stage (top level = overview only)
  INDEX.md       # pointer: role of each subfolder + links (the navigation spine)
  plan.md        # campaign playbook: stages / funnel / decision points (vim-editable)
  cluster.md     # CONFIRMED cluster+env: cluster id/SSH host/account/partition/walltime/
                 #   ntasks / binary+load / POTCAR root / python env / remote base dir /
                 #   reference script. Never guessed — see setup gate.

  literature/    # knowledge base: grounds plan + brainstorming; borrow during calc; mine for skills
    INDEX.md     # pointer: each paper/repo's relevance + key takeaways (read this first)
    papers/
      <paper-slug>/
        paper.md   # MinerU: PDF -> markdown
        notes.md   # key settings/method/findings summary (cited by plan.md)
    repos/
      <repo-slug>/
        POINTER.md # repo URL/commit/purpose + extracted relevant snippets
        (optional shallow clone)
    extracted-skills.md  # reusable recipes mined from lit/repos -> promote good ones to global SKILL lib

  refs/          # shared reference calculations (H2 molecule, clean host slab) — computed once
    INDEX.md

  scripts/       # all scripts in one place
    INDEX.md     # pointer: each script's purpose + usage
    reference_job.sb    # user-provided working job script; CatGO adapts it per calc
    submit_vasp.sh  collect.py  ...

  calc/          # the calculations, named by paper-narrative / funnel stage (human-readable)
    01-stability-formation-energy/
      INDEX.md
      Pt1-Cu_SAA/
        plan.md    # calc-level recipe (see "Two-level plan")
        STATUS.md  # job state / cluster + remote work_dir / job type / jobid / timestamps
        LESSONS.md # evolving experience & gotchas (curated, not bloated)
        result.md  # parsed result values
        INCAR POSCAR KPOINTS ...   # rendered input files; POTCAR via pointer
      Cu-host_clean/ ...
    02-activity-dGH/ ...

  analysis/      # cross-calc aggregation (the part DB-only makes hard to see)
    INDEX.md
    formation_energy_ranking.(md|csv)
    volcano.(md|png) ; volcano.csv
    funnel.md      # stage ① N candidates -> stable K -> stage ② activity top-M

  report/        # group-meeting / seminar reports
    INDEX.md     # pointer: each report's date / occasion / topic
    2026-06-06-groupmeeting/
      report.md    # drawn from analysis + campaign narrative + literature
      figures/
      slides.(md|pptx)  # optional

  archive/       # outdated / abandoned calculations moved here (keeps active tree clean)
```

Every level uses the **README (description) + INDEX (pointer)** pair. Every markdown file
follows the progressive convention.

### Markdown file roles

- **README.md** (description) — what/why/current stage. Top-level = overview only.
- **INDEX.md** (pointer) — one line per child + its role. The navigation spine; the agent
  reads INDEX to know where to go without reading everything (progressive).
- **plan.md** (two levels — see below).
- **cluster.md** — the confirmed cluster + compute environment (cluster identity + SSH
  host/account + `partition`/`walltime`/`ntasks`, binary + load method, POTCAR root,
  python env, remote base dir, which reference script). Written via the setup gate, never
  guessed; read before every render/submit. See "Environment confirmation".
- **STATUS.md** (per calc) — job state (`PENDING`/`RUNNING`/`DONE`/`FAILED`), cluster +
  remote `work_dir` (the **human-readable mirrored path**, never a hash), job type (e.g.
  `vasp geo_opt`), slurm jobid, timestamps. **This is the durable cursor that replaces DB
  rows.** The loop reads/writes it; a fresh session resumes from it + `squeue`.
- **LESSONS.md** (per calc, evolving) — what went wrong/right, fixes, gotchas (e.g. "this
  build's parallel HDF5 is broken on Lustre → set `LH5=False`"). Curated, kept lean.
- **result.md** (per calc) — parsed result values (energy, ΔG, frequencies…).
- **literature notes / extracted-skills / analysis / report** — as above.

### Progressive-markdown convention (global)

Written into the campaign SKILL; the agent obeys it whenever it creates or updates any md:

1. Each md opens with a **1–3 line TL;DR**; details below in greppable sections.
2. **Hierarchical navigation**: a parent `INDEX.md` one-lines each child; the child holds
   the fuller md. The agent reads top-down and **loads only the branch it needs**.
3. **Don't pile everything into one big md** — split by concern, stitch with INDEX.
4. `STATUS.md` / `LESSONS.md` stay **curated, not append-only logs**.

### Two-level plan

- **Project `plan.md`** = the campaign playbook: stages, the funnel, decision points, and
  the criteria used at each decision point.
- **Calc `plan.md`** (one per calculation folder) = the recipe for that single
  calculation: goal; method + parameter rationale (with literature citations);
  convergence criteria; failure/restart strategy (e.g. "SCF diverges → `ALGO=All`; this
  build needs `LH5=False`"); what result to extract; dependencies (sibling clean-slab
  energy, `refs/H2`).

The agent reads the project plan to know which stage it is in, and **only reads a calc's
`plan.md` when it works that calc** — naturally progressive. Templates (B1) emit both the
campaign structure and per-calc plan templates; lessons learned flow back into
`LESSONS.md` and the good ones improve the plan templates.

### Loop mechanics

Human triggers the loop (e.g. a "start campaign" action / `/loop`). Each wake (~10 min,
configurable):

1. Read `plan.md` + the `STATUS.md` of **only the active** calcs (progressive).
2. Poll `squeue` on each relevant cluster.
3. Update each active `STATUS.md`.
4. For finished jobs: collect → `result.md`; record anything notable in `LESSONS.md`.
5. Advance, **within the current stage**, any downstream calcs that are now ready: render
   their inputs locally, then **stop at the per-submission input-file gate** — show the
   user the rendered `INCAR`/`POSCAR`/`KPOINTS`/`POTCAR`/`job.sb` and ask to confirm before
   `scp` + `ssh sbatch`. Submit only on confirmation (or immediately if `YOLO` is on).
6. At a **stage end / decision point**: write a stage summary to `analysis/`/`report` and
   **checkpoint** — if the human is present, ask proceed/modify/stop; if away, hold at the
   checkpoint (keep polling running jobs, do not cross the stage) unless `autopilot` is on.
7. On an unhandleable problem: write it to `STATUS.md`/`LESSONS.md` and surface to the
   human (stop).

**Keep the loop context lean** (just `plan.md` + active `STATUS.md`) so each wake is cheap
despite the ~10 min interval exceeding the prompt-cache TTL. The human can take over at
any time by editing files or talking to the agent; the agent re-reads on the next tick.

### Environment confirmation (setup gate)

Before the campaign submits **anything**, the agent runs a one-time setup confirmation and
records the answers in `<project>/cluster.md` (human-readable, read before every render /
submit). **None of these are ever guessed** — the agent asks the user:

- **Target cluster + connection + job params** — which cluster (Expanse / Shaheen /
  local), the SSH host / account, and `partition` / `walltime` / `ntasks`. The user may
  have several connections active, so the cluster is never assumed.
- **Compute binary + load method** — the run command (e.g. `srun vasp_std`) and how the
  binary gets on `PATH` (a `module load …`, a `conda activate …`, or a full path).
- **POTCAR / pseudopotential root** — e.g. Expanse `/home/gliu3/vasp_pot` (and functional).
  On Expanse a POTCAR can be generated with `echo -e 103 | vaspkit`.
- **Python environment** — conda env / venv / module used for post-processing on the
  cluster (e.g. `conda activate my_pymatgen`).
- **Remote compute base directory** — where the mirrored project tree lives on the cluster
  (e.g. `/expanse/projects/qstore/csd807/gliu3/catgo`).

**Reference job script (preferred path).** The user may point CatGO at a known-working job
script — either a local file or **a path on the cluster** (e.g.
`/expanse/.../vasp_test/vasp_test.sb`), which CatGO fetches via `scp`/`ssh cat` into
`scripts/reference_job.sb`. CatGO then **adapts** it per calc — substituting the work_dir,
structure, resource lines (`#SBATCH`), and the run command — **instead of generating the
module/conda preamble from scratch**. This is the safest route (the user's proven script is
ground truth; see the wli7-vs-gliu3 VASP-build lesson). If no reference script is given,
the agent confirms the binary/module/env explicitly and writes a script, still gated.

After `cluster.md` is filled, the agent runs **`catgo_validate_config`** (SSH-checks POTCAR
root + per-element pseudopotentials + binary resolution) before the first submit. The
campaign **refuses to submit** while `cluster.md` is missing required fields — no guessed
paths ever reach `sbatch`.

`cluster.md` can be seeded from a reusable per-cluster profile the user has confirmed
before, but each project still shows (and the agent still verifies) the resolved values.

### Remote layout & job submission

The HPC side **mirrors the local campaign tree** with the **same human-readable folder
names** — no hashes, no `{workflow_id}:{node_id}` namespacing. `ssh`-ing into the cluster
and running `ls` should be as legible as the local project:

```
<remote_base>/<project>/calc/01-stability-formation-energy/Pt1-Cu_SAA/
    INCAR POSCAR KPOINTS POTCAR  job.sb
    README.md     # 1-line: what this calc is (so the remote dir is self-describing)
```

- **Names from the path hierarchy, not hashes.** `project/stage/candidate` is already
  unique. On the rare name clash, disambiguate with a readable suffix (`-2`), never a hash.
- **Submission is plain ssh + sbatch.** Render inputs locally (the `job.sb` **adapted from
  `scripts/reference_job.sb`** per the confirmed `cluster.md`, not guessed) → `scp` (or
  rsync) into the mirrored remote path → `ssh <cluster> "cd <remote> && sbatch job.sb"`.
  Capture the returned jobid into `STATUS.md`. Monitoring is `ssh <cluster> squeue`. No
  bespoke scheduler protocol. (The existing CLI `catgo submit` already does scp + sbatch
  via stdlib subprocess; md-mode reuses that simplicity.)
- **The remote stays clean and tidy too.** Push only what a run needs (inputs + job
  script + a 1-line README); don't litter the remote with scratch. Apply the same
  archive/cleanup policy remotely — superseded runs move to a remote `archive/` (or are
  pruned after results are collected back), so the live remote tree mirrors the clean local
  one. Heavy outputs (WAVECAR, vaspout.h5) stay on the cluster and are not pulled unless
  needed; only parsed values come back into `result.md`.
- **Authority:** local `STATUS.md` is the source of truth; the remote tree holds the
  inputs/outputs and is self-describing but is driven from the local loop.

### Checkpoint / review-gate semantics

Reuses the established philosophy: **default human-in-the-loop**. There are **two gate
granularities**, both ON by default, both disabled by the same opt-in:

1. **Per-submission input-file gate** (the important one — don't forget it). Before the
   agent submits **any** job, it must present / point the user to the actually-rendered
   input files (`INCAR` / `POSCAR` / `KPOINTS`, the resolved `POTCAR`, the `job.sb`) and
   **ask the user to confirm** ("inputs ready for `Pt1-Cu_SAA geo_opt` — submit?"). It does
   **not** `ssh sbatch` until the user confirms. This is the md-mode form of the
   `auto_submit: false` / `PENDING_REVIEW` review gate.
2. **Stage / decision-point checkpoint.** The loop will not cross a stage or a `plan.md`
   `decision point` without confirmation; it writes a human-readable stage summary
   (doubling as campaign progress and report input) and waits.

**The opt-in (`YOLO` / `autopilot`)** disables both gates. It can be set per-run
("go as you set" / "just submit it" / "yolo") or persistently ("always skip review from
now on"). With YOLO on, the agent renders → submits without asking and crosses decision
points using the criteria encoded in `plan.md` (e.g. "keep candidates with `E_form < 0`",
"advance only the stability survivors to activity"). Without YOLO, when the human is away,
the loop **holds at the gate** — it keeps polling already-running jobs but submits nothing
new and crosses no stage until the human confirms.

### Literature → plan → skill flow

1. User drops PDFs + GitHub links into `literature/`.
2. Agent runs **MinerU** on PDFs → `paper.md`; repos → `POINTER.md` + summary (optional
   shallow clone).
3. Agent reads `literature/INDEX.md` → **grounds the brainstorm / plan** → `plan.md` cites
   specific sources (e.g. "ENCUT=520 per [paperX SI]", "ΔG_H* reference scheme per
   [paperY]").
4. During calculation, `LESSONS.md` may cite literature.
5. **Skill extraction**: good recipes → `extracted-skills.md`; curated ones are promoted
   into the global CatGO SKILL library for cross-project reuse.

### Relationship to existing CatGO

- Existing per-software SKILLs (`vasp/`, `cp2k/`, `orca/`, `structure/`, `analysis/`,
  `troubleshooting/`) are **unchanged**; the agent calls them to render inputs / parse
  outputs.
- **New**: a campaign-orchestration SKILL (defines md conventions + drives the loop) + a
  template library + a folder scaffolder + the loop convention + MinerU integration.
- The DB engine is untouched (visual mode keeps using it).
- md-mode mostly uses file tools (`Read`/`Write`/`Edit`/`Glob`/`Grep`) + existing
  `catgo_structure` / `catgo_analyze` + SSH submit/monitor. A thin optional helper
  (`catgo_campaign`) may scaffold folders and poll `squeue`, but most of this can be pure
  SKILL + file ops.

## Worked example: single-atom-alloy (SAA) HER high-throughput screening

A funnel campaign, inherently cross-workflow:

| Stage | Computes | Per-candidate calc DAG |
|-------|----------|------------------------|
| ① Stability | formation energy `E_form` (+ segregation?) | SAA slab → geo_opt → energy |
| ② Activity | `ΔG_H*` (hydrogen adsorption free energy) | clean slab + *H slab → geo_opt → freq → gibbs |
| ③ Analysis | `E_form` ranking, volcano, funnel | **aggregate all candidates' results** |

Shared references (`H2`, `clean host slab`) live in `refs/`, computed once. Stage ② only
expands the stability survivors. The volcano/funnel/ranking live in `analysis/`. A
group-meeting `report/` is drafted from `analysis/` + the campaign narrative + `literature/`.

## Components to build

1. **Campaign SKILL** — md conventions, two-level plan, progressive rules, loop protocol,
   checkpoint/review-gate semantics, literature/skill-extraction flow.
2. **Template library** — at least one campaign template (SAA HER) + per-calc plan
   templates; structured so more can be added.
3. **Folder scaffolder** — create the tree at a user-chosen location, seed README/INDEX/plan.
4. **Mode selection** — the create-time visualize? prompt with trade-offs; route to DB vs
   md scaffolder.
5. **Loop runner convention** — wake interval, lean context, poll/advance/checkpoint.
6. **Environment setup gate + reference-script adapter** — confirm & record `cluster.md`
   (binary+load, POTCAR root, python env, remote base); adapt `scripts/reference_job.sb`
   per calc (substitute work_dir/structure/`#SBATCH`/run command); refuse to submit while
   required fields are missing; run `catgo_validate_config` before first submit.
7. **Remote sync + submit** — mirror the readable tree to `<remote_base>/<project>/…`,
   `scp`/rsync inputs, `ssh <cluster> "cd <remote> && sbatch job.sb"`, capture jobid;
   `ssh squeue` for monitoring; keep the remote tree clean (push only what's needed,
   mirror the archive/cleanup policy). Reuses the CLI `catgo submit` scp+sbatch path.
8. **MinerU integration** — PDF→md conversion (script in `scripts/` or backend endpoint).
9. **(Optional) thin `catgo_campaign` MCP helper** — scaffolding + cross-cluster `squeue`.

## Phasing (refine in writing-plans)

- **MVP**: folder convention + scaffolder + campaign SKILL + one SAA HER template +
  `cluster.md` setup gate + reference-script adaptation + input-file gate + loop
  (render → `scp` → `ssh sbatch` submit / `ssh squeue` monitor / `STATUS.md` / checkpoint),
  with the remote mirroring the readable local tree.
- **P2**: more templates; `analysis/` aggregation (volcano/funnel); `report/` generation;
  `archive/` auto-archiving; mode-selection UI; MinerU + literature ingestion; skill
  promotion.

## Open questions / risks / dependencies

- **MinerU** is an external dependency (install/availability per machine). Degrade
  gracefully if absent (manual md drop still works).
- **Multi-cluster `squeue`** — the loop must poll each cluster a campaign touches; per-calc
  `STATUS.md` records which cluster.
- **Loop token cost** — mitigated by lean context + progressive md; needs measuring.
- **Convention drift** — without a schema, consistency depends on the SKILL + templates;
  the SKILL must be prescriptive.
- **Skill promotion** — moving `extracted-skills.md` recipes into the global library is a
  curated/manual step (not automatic) for now.

## Out of scope (YAGNI)

- Replacing or migrating the existing DB engine. (Coexistence only.)
- Auto-rendering a node graph for md-mode (no whole-campaign GUI picture in MVP).
- Fully automatic skill promotion to the global library.
- Unattended (no-agent) advancement — md-mode advances only while the loop/agent runs.

## Testing approach

- Scaffolder: assert the full tree + seed md files are created at the chosen location with
  the README/INDEX pair at each level.
- Progressive-md convention: lint that generated md files have a TL;DR head and that each
  folder has an `INDEX.md`.
- `STATUS.md` round-trip: a fresh agent can reconstruct campaign state from
  `STATUS.md` + a mocked `squeue` (no DB).
- Loop protocol: simulate job completion → assert collect → `result.md`, stage summary
  written, checkpoint reached, and that it holds (no stage crossing) without confirmation.
- Input-file gate: by default the agent renders inputs but does **not** `ssh sbatch`
  without confirmation; with `YOLO` set it submits without asking.
- Environment gate: with `cluster.md` missing required fields (cluster id/connection/job
  params, binary/load, POTCAR root, python env, remote base), the campaign refuses to
  submit (no guessed paths, no assumed cluster); a reference script given as a remote
  cluster path is fetched (mocked `scp`/`ssh cat`) into `scripts/reference_job.sb` and
  adapted (work_dir/structure/resources substituted) rather than regenerated.
- Checkpoint/review-gate: default holds at stage/decision points; `YOLO`/`autopilot`
  crosses using `plan.md` criteria.
- Literature flow: a PDF (mocked MinerU) lands as `paper.md` + `notes.md`, and `plan.md`
  generation can cite it.
- Remote mirror: the computed remote path is the human-readable `project/stage/candidate`
  (assert no hash / no `:` namespacing); a name clash disambiguates with `-2`, not a hash;
  after result collection the remote tree is left tidy (scratch archived/pruned).
```
