---
name: catgo-campaign-loop
description: Run and resume the CatGo md-orchestration poll loop — delegate each poll to a subagent (keep main context lean), verify convergence by force, auto-advance each converged species per-species (pipeline, not barrier), and resume a campaign from disk after context compaction / new session. Use when driving or resuming a campaign's job-watch loop. Pairs with catgo-campaign.
---

# catgo-campaign-loop — drive & resume the poll loop

> **TL;DR:** Human-triggered ~10-min loop. **Delegate each poll to a subagent** (compact
> summary back). Verify convergence by **force**. **Auto-advance** each converged species
> to its next step (per species, not a barrier). State is on disk → any agent resumes.

## RULE — delegate each poll to a subagent
Do NOT run poll/verify inline. Dispatch ONE subagent (opus) to run steps 1-3 (poll,
ssh-read OUTCAR, verify, write result.md/STATUS/LESSONS) and return a **compact summary
only** (one line per calc; no raw OUTCAR/OSZICAR/ssh dumps) — over a long run the verbose
output would fill the main context toward 1M. **Gates stay in the main agent** (input-file
gate, checkpoints): the subagent reports, the main agent shows the user + acts. The subagent
must not submit/cancel jobs or touch the :8000 backend.

## Each wake
1. Read `plan.md` + active `STATUS.md` (keep working context lean).
2. `python poll.py --project <dir> --ssh <alias>` — updates STATUS: queued via `squeue`;
   once a job leaves the queue, `sacct` gives the terminal verdict (COMPLETED→DONE;
   FAILED/TIMEOUT/OUT_OF_MEMORY/CANCELLED→FAILED; `exit_code` recorded).
3. For finished calcs: **a scheduler DONE ≠ "the science succeeded"** — open the remote
   outputs and verify real convergence by **`FORCES: max atom` < |EDIFFG|** (force, NOT
   dE; the "kinetic energy error for atom" EATOM line is benign). Write energy_eV +
   max_force_eVA into `result.md`; on real failure (DONE-but-unconverged, or FAILED)
   record cause + fix in `LESSONS.md`.
4. **Auto-advance each newly-converged calc to its NEXT plan step — per species, PIPELINE,
   not a barrier.** A converged geo_opt immediately triggers that species' next step (e.g.
   freq in a Gibbs study) from its CONTCAR; don't wait for siblings, don't wait for a user
   reminder. Render next-step inputs → **input-file gate** → `submit_calc.py`.
   **⛔ INPUT-FILE GATE (hard rule):** "auto-advance" means auto-PREP, NOT auto-submit. Sync the
   converged CONTCAR **and** the next-step INCAR to the LOCAL folder, tell the user the exact LOCAL
   paths of INCAR + CONTCAR, and WAIT — the user checks/edits the files on disk. Submit ONLY after
   the user confirms. Do NOT push to the CatGO viewer as a substitute, and NEVER auto-submit. (YOLO waives.)
5. Stage/decision point → `python aggregate.py --project <dir> --plot` → summary → checkpoint.
6. Group meeting → `python make_report.py --project <dir> --occasion groupmeeting`.
7. Unhandleable problem → write it to STATUS/LESSONS and stop (surface to the user).

## Resuming (fresh agent / after compaction)
State lives ON DISK, not in context — a campaign survives compaction, a new session, or a
different agent. To resume with **zero conversation history**:
1. Invoke the `catgo-campaign` skill; identify the project dir.
2. Read in order: `README.md` → `plan.md` (+ each `calc/<stage>/plan.md`) → `cluster.md` →
   every `calc/**/STATUS.md` → `result.md` files → `LESSONS.md` = done / running / next.
3. Continue the loop (delegate each poll to a subagent).
Keep the discipline: flush results/STATUS/LESSONS/plan to files **as it happens** — never
hold campaign state only in context.

## Unattended (fully-ended session)
ScheduleWakeup dies with the session. For a campaign that must advance without you, register
a **cron routine** that wakes a fresh agent on a schedule to poll the project (it resumes
from disk). Otherwise the user says "resume <project>" in a new session.
