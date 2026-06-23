# AGENTS.md — working conventions for agents on CatGo

Portable conventions for any agent (Claude Code, CatBot, …) working in this repo. This is
the **shared baseline** — it ships with the repo. Personal/machine-only preferences live in
each user's own memory, not here.

## Skills (use them; don't reinvent)
- **Campaign** (file-first md-orchestration): `catgo-campaign` + `catgo-campaign-conventions`
  + `catgo-campaign-loop` + `catgo-gibbs-pipeline`, in `server/catgo/workflow/skills/`.
  Run **`catgo setup`** to symlink them into `~/.claude/skills` for Claude Code discovery.
- **Per-software / task**: `vasp-*`, `cp2k-*`, `orca-*`, `her`/`oer`/`gibbs`/`co2rr`/`nrr`,
  `structure-*`, `convergence-test`, `energy-diagram`, `volcano-plot`, `troubleshoot-*`.

## Authoring / editing skills
- ALWAYS use the **skill-creator** plugin + the standard folder tree:
  `SKILL.md` (lean; frontmatter `name`+`description`) + `references/` + `scripts/` +
  `examples/` + `assets/` (bundled resources optional / as-needed).
- Keep router SKILLs **lean**; factor specific/reusable methods into separate focused skills
  and point to them. When test runs or live work re-derive the same helper, **bundle it in
  `scripts/`**.

## Long-running / poll loops
- Delegate each iteration's verbose work (ssh, log reads, command dumps) to a **subagent**
  that returns a COMPACT summary — keeps the main context off the 1M wall. Gates/decisions
  needing user confirmation stay in the **main** agent. Subagents must not start/stop the
  shared `:8000` backend.

## HPC / compute config — never guess
- Never guess the POTCAR/pseudopotential path, compute binary/module-load, python env, or
  cluster identity — **confirm with the user** (per-user/per-cluster; a wrong path fails
  every job). The campaign `submit` refuses an unconfirmed `cluster.md` (enforced in code).

## Gibbs / ΔG / overpotential studies
- Target a FREE energy ⇒ per-species **`geo_opt → freq → gibbs`** (raw DFT energies are
  wrong). Follow the `catgo-gibbs-pipeline` skill. Auto-advance each species to freq on
  convergence (pipeline, not a barrier). Judge geo_opt convergence by **force**
  (`FORCES: max atom` < |EDIFFG|), not dE. freq = Γ-only, no NCORE, shared/`vasp_gam`,
  only the adsorbate atoms free.

## File-first campaigns
- State lives ON DISK (plan / STATUS / result / LESSONS) — resume from files, not chat.
  Flush results/STATUS/LESSONS **as they happen**; log every intervention (cancel / rebuild
  / retry / gotcha) to `LESSONS.md`; keep `README.md` + `INDEX.md` current. Use review gates
  (input-file confirm; stage checkpoints) by default — auto-advance only on explicit opt-in.

## Review gates (default human-in-the-loop)
- Don't auto-submit a freshly built workflow/campaign; show inputs, confirm, then submit.
  Skip only on explicit user opt-in ("go as you set" / "yolo" / "always skip").

## Agent Bridge Notes

### [2026-06-23] Claude settings env fallback
**Category**: bug
**Context**: Desktop CatBot Claude Code provider returned blank replies when users configured proxy env only in `~/.claude/settings.json`.
**Discovery**: The sidecar disabled Claude global setting sources and inherited only OS env, so `ANTHROPIC_BASE_URL` / auth env in Claude settings were invisible.
**Solution/Note**: Claude adapter now loads only the `env` map from `settings.json` / `settings.local.json` as fallback, without enabling global MCP/settings loading.
