---
name: catgo-campaign-conventions
description: Authoring conventions for CatGo md-orchestration campaigns — progressive markdown, README+INDEX pairs and keeping them current, logging interventions to LESSONS, human-readable (never-hash) names, and the progressive (top→stage→calc) plan. Use when creating/editing any campaign markdown (plan/README/INDEX/STATUS/LESSONS) so the file tree stays navigable and resumable. Pairs with catgo-campaign.
---

# catgo-campaign-conventions — how to author campaign markdown

> **TL;DR:** Progressive md (TL;DR-first, drill down), a README+INDEX pair at every level
> kept current, log every intervention to LESSONS, human-readable names (no hashes), and a
> top→stage→calc progressive plan. These keep the tree navigable + resumable from disk.

## Progressive markdown
Every md opens with `# title` + a `> **TL;DR:**` line, details below in greppable sections.
Read `INDEX.md` first; drill into a branch only when you work it. Keep `STATUS.md` /
`LESSONS.md` **curated, not append-only logs**. Don't pile everything into one big md —
split by concern, stitch with INDEX.

## README + INDEX pair (kept current)
Every level has a **README** (description) + **INDEX** (pointer/navigation).
- **When you add a stage or calc folder, update the parent `INDEX.md`** (one line + role).
  INDEX is the navigation spine — an empty/stale INDEX breaks drill-down.
- **Fill the scaffold's stub files** — top `README.md` (what / goal / current stage),
  `plan.md`, `cluster.md`. Never leave the `<...>` placeholders the scaffolder writes.
- README (human: what the project is) vs CLAUDE.md (agent bootstrap) vs INDEX (pointer) —
  distinct roles, don't duplicate.

## Log every intervention
Any time you cancel / rebuild / retry a calc, change its inputs, or hit a gotcha, record
what changed and **why** in that calc's `LESSONS.md` (and the project `LESSONS.md` if it
generalizes). `STATUS.md` only holds the CURRENT job — it does not remember a prior
cancelled/failed attempt, so the history lives in LESSONS. (`catgo campaign submit` updates
STATUS.md automatically; LESSONS is on you.)

## Human-readable names (never hashes)
Names are readable; uniqueness comes from the `project/stage/calc` path hierarchy. A clash
gets a readable `-2` suffix, never a digest. The remote work_dir mirrors the local tree.

## Progressive plan (top → stage → calc)
- Top `plan.md` = only WHAT (goal + the stage list, each line LINKING to that stage's plan).
- `calc/<stage>/plan.md` = mid-level detail + links to its calcs.
- `calc/<stage>/<calc>/plan.md` = the FULL recipe (method, params + rationale, convergence,
  freq/restart strategy, result to extract, dependencies).
Keep the top short; push specifics down. (Flat campaign with no stages → two levels suffice.)
