---
name: catgo-campaign
description: Run a CatGo file-first md-orchestration "campaign" — a multi-step / high-throughput computational-materials study (e.g. SAA HER screening) driven from a human-readable folder + markdown tree, not the DB workflow engine. Use when the user says "跑一个 campaign", "md 模式跑", "high-throughput screening", or wants an agent-in-the-loop study with stages/funnel/analysis/report. Requires `catgo` on PATH.
---

# catgo-campaign — run a file-first computational campaign

A "campaign" = a coordinated multi-step study (many calculations → analysis → report)
toward one research goal. This skill drives it via the portable `catgo campaign` CLI,
which dispatches to CatGo's campaign reference scripts.

## Launcher (works from any directory)
Run via the `catgo` CLI:

    catgo campaign <action> ...

With an editable install (`pip install -e <repo>/server`) the CLI reflects the LIVE repo
source, so edits to the campaign scripts/SKILL take effect immediately, no reinstall.
If `catgo` is not on PATH (env not activated), use the entry point inside its python
env directly: `<env-prefix>/bin/catgo campaign ...`.
In the steps below, `catgo campaign` means that launcher.

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
4. **Per calc**: build inputs into the LOCAL calc folder, then the **input-file gate** (below),
   then `catgo campaign submit --project <dir> --calc calc/<stage>/<candidate> --ssh <alias>`
   (skip the gate only on explicit YOLO opt-in).

   **⛔ INPUT-FILE GATE (hard rule — catgo-campaign + autochem).** Before ANY submit (and after a
   calc converges, before building the NEXT step's inputs): sync the CONTCAR **and** the INCAR to
   the LOCAL campaign folder, and **tell the user the exact LOCAL file paths** of the INCAR +
   CONTCAR. The user reviews / edits / confirms the files THEMSELVES on disk. Submit ONLY after the
   user explicitly confirms. Do **NOT** push structures to the CatGO viewer as a substitute for
   local-file review of inputs, and **NEVER auto-submit**. (Waived only by explicit YOLO.)
5. **Loop** (~10 min, user-triggered): `catgo campaign poll --project <dir> --ssh <alias>`
   marks DONE/FAILED via squeue→sacct. A scheduler DONE != converged — open the
   work_dir outputs to confirm, write numbers into the calc's `result.md`, log gotchas
   in `LESSONS.md`.
6. **At a stage / decision point**: `catgo campaign aggregate --project <dir> --plot`
   (ranking / volcano / funnel), then checkpoint with the user.
7. **Report**: `catgo campaign report --project <dir> --occasion groupmeeting`
8. **Literature**: `catgo campaign ingest --project <dir> --pdf <p.pdf>` (MinerU) or
   `--repo <url> --purpose "…"`.
9. **Archive** (clean the tree, never auto-decide): `catgo campaign archive --project <dir> --list`
   proposes FAILED calcs (funnel rejects are kept as data); move one only on the user's
   explicit OK: `catgo campaign archive --project <dir> --calc calc/<stage>/<name> --reason "…"`.

## Notes
- Default to a review gate (user-in-the-loop); only auto-advance on explicit opt-in.
- Full conventions live in the in-repo skill `server/catgo/workflow/skills/campaign/SKILL.md`
  (read it for the folder layout, progressive-md rules, two-level plan, gate details).
