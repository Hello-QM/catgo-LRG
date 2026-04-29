# Repository Bug Analysis

Date: 2026-03-13

Last revalidated against current source: 2026-03-13

Scope:

- read-only analysis of the current repository state
- no source changes were made
- this file is kept in sync with later revalidation passes on the same date

Checks run:

- `pnpm check`
- `pytest -q server/tests/test_tool_registry.py -q`

## Findings

### 1. Post-mount prop update bugs in `Composition`, `BarPlot`, and `ScatterPlot`

Severity: high

Status: fixed

Evidence:

- `src/lib/composition/Composition.svelte:24-28` now synchronizes `current_color_scheme` and `current_mode` from parent props with `$effect(...)`
- `src/lib/plot/BarPlot.svelte:74-86` now derives merged `bar`, `line`, and `y2_axis` config reactively via `$derived(...)`
- `src/lib/plot/ScatterPlot.svelte:123-151` now derives merged `styles`, `x_axis`, `y_axis`, `y2_axis`, `display`, and `controls` reactively via `$derived(...)`

What changed:

- the earlier mount-time snapshot behavior has been replaced with reactive merges / sync effects
- the original “post-mount updates freeze” diagnosis is no longer accurate for these three components

Current status note:

- the old bug report is now historical
- the commented TODO in the composition test may still deserve cleanup, but it no longer matches the current component wiring

### 2. `ResultsTable` still mishandles rows whose `EnrichedResult.id` is `null`

Severity: high

Status: fixed (2026-03-13)

What changed:

- `ResultsTable.svelte` refactored from `selected_ids: Set<number>` to `selected_keys: Set<string>`
- added `row_key(result, index)` helper: returns `String(id)` for non-null, `__null_${index}` for null-id rows
- all rows are now selectable, including null-id rows
- header checkbox, select_all, toggle_select, and export logic all use string keys
- the underlying model mismatch is resolved

### 3. `ProjectDashboard` synthetic UV-Vis convergence-point bug

Severity: medium

Status: fixed

Evidence:

- `src/lib/workflow/ProjectDashboard.svelte:153-161` now returns `points: []` for live `orca_uvvis` progress and carries status in `message`
- no fabricated convergence point is injected in the live UV-Vis branch anymore
- `src/lib/workflow/ConvergencePlot.svelte:28` still renders convergence only when `points.length > 0`

What changed:

- the earlier fake-point behavior has been removed
- UV-Vis progress is now represented as “no convergence series + message”, which matches the absence of a true optimization trajectory

Current status note:

- this bug is now historical

### 4. Bond thickness reactivity bug

Severity: medium

Status: fixed

Evidence:

- `src/lib/structure/Bond.svelte:181-186` now derives geometry reactively from `group?.thickness`
- `<T.InstancedMesh>` is constructed with that derived geometry, so thickness changes now flow through the component

What changed:

- the earlier mount-time geometry assumption is no longer accurate

Current status note:

- this bug is now historical

### 5. Zero-length lattice-vector normalization bug

Severity: medium

Status: fixed

Evidence:

- `src/lib/structure/Lattice.svelte:71-81` now returns early for zero-length edge segments before normalization
- `src/lib/structure/Lattice.svelte:137` now guards lattice-vector direction with `vec_length > 1e-10 ? ...normalize() : new Vector3(0, 1, 0)`

What changed:

- the unconditional normalization path described in the earlier report is no longer present

Current status note:

- this bug is now historical

### 6. Repository TypeScript config alignment with SvelteKit

Severity: medium

Status: fixed

Evidence:

- `tsconfig.json:2` now extends `./.svelte-kit/tsconfig.json`

What changed:

- the earlier configuration mismatch has been corrected

Current status note:

- this bug is now historical

## Notes

- the `ResultsTable` null-id issue is now fully resolved via string-key selection
- this file also supersedes earlier wording that described the UV-Vis placeholder as structurally incomplete; the current issue is semantic rather than purely structural
- a separate follow-up report exists at `reports/bug-followup-2026-03-13.md`
- as of the latest revalidation pass on 2026-03-13, all items tracked in this report are fixed
- the remaining known open issue tracked in repository Markdown is the terminal IME bug:
  - `TERMINAL_IME_BUG.md`
  - `reports/terminal-ime-investigation-2026-03-13.md`
