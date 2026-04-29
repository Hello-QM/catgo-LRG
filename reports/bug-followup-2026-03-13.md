# Bug Follow-up Report

Date: 2026-03-13

Scope:

- continued repository bug review without source-code changes
- emphasis on workflow / CatBot behavior
- additional UI / rendering issues found while checking current docs against code

## Confirmed Findings

### 1. Workflow results selection breaks for rows with `id == null`

Status:

- fixed (2026-03-13)

What changed:

- `ResultsTable.svelte` refactored to use `selected_keys: Set<string>` with `row_key()` helper
- null-id rows now use synthetic `__null_${index}` keys and are fully selectable
- header checkbox, select_all, toggle_select, and export all use string keys

### 2. Workflow dashboard fake UV-Vis convergence-point bug

Status:

- fixed

Files:

- `src/lib/workflow/ProjectDashboard.svelte`
- `src/lib/workflow/ConvergencePlot.svelte`

What happens:

- the dashboard uses `get_orca_uvvis_progress_light()` for running `orca_uvvis` steps
- the live `orca_uvvis` path now returns `points: []` plus a status `message`
- the generic convergence plot only renders when `points.length > 0`

Impact:

- the earlier fabricated convergence-point behavior is no longer present

Key references:

- `src/lib/workflow/ProjectDashboard.svelte:153`
- `src/lib/workflow/ProjectDashboard.svelte:158`
- `src/lib/workflow/ConvergencePlot.svelte:28`

### 3. `Composition.svelte` snapshots props into local state and misses later parent updates

Status:

- fixed

Files:

- `src/lib/composition/Composition.svelte`
- `tests/vitest/composition/Composition.svelte.test.ts`

What happens:

- `mode` and `color_scheme` are read from `$props()`
- local UI state is still kept for context-menu changes
- parent prop updates are now synchronized back into that local state with `$effect(...)`

Evidence:

- current component code now contains explicit sync effects for `mode` and `color_scheme`

Impact:

- the original prop-freeze bug has been fixed

Key references:

- `src/lib/composition/Composition.svelte:24`
- `src/lib/composition/Composition.svelte:27`

### 4. `Bond.svelte` uses initial thickness for geometry construction

Status:

- fixed

File:

- `src/lib/structure/Bond.svelte`

What happens:

- bond geometry is now created from a reactive `$derived(...)`
- thickness changes flow through the derived geometry rather than staying mount-time only

Impact:

- the original thickness-reactivity bug is no longer present

Key references:

- `src/lib/structure/Bond.svelte:181`
- `src/lib/structure/Bond.svelte:249`

### 5. `Lattice.svelte` still normalizes zero-length vectors

Status:

- fixed

File:

- `src/lib/structure/Lattice.svelte`

What happens:

- zero-length edge segments now return early before normalization
- lattice-vector arrows now guard normalization with a `vec_length > 1e-10` fallback

Impact:

- the earlier unconditional-normalization paths are no longer present

Key references:

- `src/lib/structure/Lattice.svelte:71`
- `src/lib/structure/Lattice.svelte:79`
- `src/lib/structure/Lattice.svelte:137`

### 6. PBC image generation has a known edge-case bug already documented in tests

Status:

- fixed (commit f1f1a12)

What changed:

- the test comment was misleading: it said “should be 0” but the algorithm is actually correct
- for atom at [0.02, 0.0, 0.0] with tolerance=0.01: x is not at boundary, but y=0 and z=0 ARE at boundary
- generating 3 images (y, z, yz-corner) is the correct behavior
- the test comment and description have been updated; all 33 PBC tests pass

### 7. Root TypeScript config is still misaligned with SvelteKit

Status:

- fixed

File:

- `tsconfig.json`

What happens:

- the root config now extends `.svelte-kit/tsconfig.json`

Impact:

- the earlier tsconfig mismatch is no longer present

Key reference:

- `tsconfig.json:2`

### 8. Legacy plugin tool-builder path references a non-existent `ToolPlugin` base class

Status:

- fixed (2026-03-13)

What changed:

- deleted `server/plugins/tool_builder.py` (dead code with broken import of non-existent `ToolPlugin`)
- deleted `server/test_self_extending.py` (orphaned test that depended on the broken tool_builder)
- neither file was imported by any active code path (routers, MCP server, managers)
- current tool lifecycle continues to use `server/tools/builder.py`

## Workflow / CatBot-Specific Summary

Status after latest revalidation:

- the workflow / CatBot issues tracked in this report are now fixed
- the detailed workflow design-status ledger is `WORKFLOW_BUGS.md`
- `WORKFLOW_BUGS.md` currently contains historical/fixed entries only; it no longer carries an active open bug from this report set

Remaining known open issue outside workflow:

- `TERMINAL_IME_BUG.md`
- `reports/terminal-ime-investigation-2026-03-13.md`

## Confidence Notes

- All findings rechecked against current source on 2026-03-13.
- Findings 1, 2, 3, 4, 5, 6, 7, and 8 are now all fixed.
- Finding 1: ResultsTable refactored to string-key selection model.
- Finding 6: PBC algorithm was correct; misleading test comment was the issue.
- Finding 8: Dead legacy files deleted.
- No non-terminal open bug remains in this follow-up report after the latest revalidation pass.
