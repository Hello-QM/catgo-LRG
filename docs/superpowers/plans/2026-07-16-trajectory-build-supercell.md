# Trajectory Build Supercell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Build → Lattice → Supercell a true scientific edit that strictly obeys trajectory `view`, `edit-current`, and `edit-all` scopes, including indexed trajectories, undo/redo, variable cells, and export.

**Architecture:** Build emits an explicit `SupercellOp`; a canonical executor stages a complete result and provenance. Each trajectory pane owns an ordered immutable operation ledger and one effective-frame resolver. Transactions capture owner/frame/scope/revision and publish atomically only when still current.

**Tech Stack:** TypeScript, Svelte 5, Web Workers, existing ferrox/TypeScript supercell algorithms, Vitest, Playwright.

## Global Constraints

- `large_system_mode` is renderer state and must never alter Build semantics.
- `view` rejects true Build supercell without mutation or history.
- Every frame uses its own lattice, sites, and atom count.
- Indexed frames remain immutable at the source; all consumers use the effective-frame resolver.
- A failure or stale completion retains the last complete scene and history.

---

## Task 1: Define SupercellOp, validation, execution, and provenance

**Files:**

- Create: `src/lib/structure/supercell-operation.ts`
- Modify: `src/lib/structure/lattice-ops.ts`
- Test: `tests/vitest/structure/supercell-operation.test.ts`

**Interfaces:** Use the approved `IntMatrix3`, `SupercellOp`, `SupercellRequestResult`, `SupercellProvenance`, and `SupercellExecution`. Export `validate_supercell_op()` and `execute_supercell_op_sync()` with a default `TRUE_SUPERCELL_MAX_ATOMS = 2_000_000`.

- [ ] Add failing tests for invalid/non-integer/singular/lattice-free/oversized transforms, N×|det| output, per-frame lattice, force rotation, and deterministic physical-site mapping.
- [ ] Run `pnpm exec vitest run tests/vitest/structure/supercell-operation.test.ts --reporter=verbose`; verify module missing.
- [ ] Refactor the existing lattice implementation to return deterministic cell ordering/provenance; reorientation must rotate Cartesian vector properties consistently.
- [ ] Re-run tests and commit with `feat(supercell): define true edit operation`.

## Task 2: Stage large transforms in a Worker and delegate LatticePane

**Files:**

- Create: `src/lib/structure/workers/supercell-worker.ts`
- Create: `src/lib/structure/workers/supercell-worker-api.ts`
- Modify: `src/lib/structure/LatticePane.svelte`
- Modify: `src/lib/structure/Structure.svelte`
- Test: `tests/vitest/structure/supercell-worker-api.test.ts`
- Modify: `tests/playwright/structure/lattice.test.ts`

**Interface produced:** `SupercellExecutor.execute(structure, op, {source_frame_id, signal, max_atoms})` and `LatticePane.on_supercell_request?: (op) => Promise<SupercellRequestResult>`.

- [ ] Add failing tests that delegated requests do not mutate/push local undo, standalone publishes only after success, rejection preserves structure, and large-system mode still performs a true edit.
- [ ] Run the targeted Vitest and Playwright grep; verify current shortcut fails.
- [ ] Call `on_supercell_request` before local mutation/undo/renderer shortcut. Standalone Structure uses the same staged executor and publishes atomically.
- [ ] Re-run tests and commit with `refactor(supercell): delegate build operations`.

## Task 3: Add a pane ledger and the only effective-frame resolver

**Files:**

- Create: `src/lib/trajectory/operation-ledger.ts`
- Create: `src/lib/trajectory/effective-frame-resolver.ts`
- Modify: `src/lib/trajectory/operations.ts`
- Modify: `src/lib/trajectory/clone.ts`
- Modify: `src/lib/trajectory/frame-loading.ts`
- Modify: `src/lib/trajectory/index.ts`
- Test: `tests/vitest/trajectory/operation-ledger.test.ts`
- Test: `tests/vitest/trajectory/effective-frame-resolver.test.ts`
- Modify: `tests/vitest/trajectory/pane-isolation.test.ts`

**Interfaces:** Use the approved `OpScope`, `LedgerEntry`, `OperationLedger`, and `TrajectoryEditOp`. Resolver exposes `resolve`, `iterate`, `invalidate`, and `clear`; cache key is `(frame_idx, ledger_revision)`.

- [ ] Add failing tests for ordered current-only A then all-frame B, inactive entries, variable N/cell, no base mutation/double transform, revision-aware caching, and pane isolation.
- [ ] Run the three targeted test files and verify modules are missing.
- [ ] Clone a base frame once per revision, apply active matching entries by `seq`, and route `create_frame_request_loader()` through the resolver. Remove transformation replay from forked loaders.
- [ ] Re-run tests and commit with `feat(trajectory): add scoped operation ledger`.

## Task 4: Implement scoped supercell transactions in Trajectory

**Files:**

- Create: `src/lib/trajectory/supercell-transactions.ts`
- Modify: `src/lib/trajectory/Trajectory.svelte`
- Modify: `tests/vitest/trajectory/frame-loading.test.ts`
- Modify: `tests/vitest/trajectory/bond-cache-invalidate.test.ts`
- Test: `tests/vitest/trajectory/supercell-transactions.test.ts`
- Modify: `tests/playwright/trajectory.test.ts`

- [ ] Add failing tests for view rejection, captured-frame current edit after scrub, lazy all-frame per-cell transforms, stale completion retention, complete cache invalidation, provenance invalidation, and renderer-mode independence.
- [ ] Run the targeted Vitest and Playwright grep; verify current behavior fails.
- [ ] Capture owner/frame/mode/ledger revision/request id before staging. Stop playback for topology-changing current edits. Commit staged frame, ledger entry, cache invalidation, captured-frame republish, and versions as one transaction.
- [ ] Migrate pending edit replay to the unified ledger so add/delete/replace/manipulate and supercell operations keep sequence order. Break provenance before a symmetry-breaking physical-site edit.
- [ ] Re-run tests and commit with `fix(trajectory): honor supercell edit scope`.

## Task 5: Add external history undo/redo

**Files:**

- Modify: `src/lib/structure/state/selection-state.svelte.ts`
- Modify: `src/lib/structure/Structure.svelte`
- Modify: `src/lib/trajectory/Trajectory.svelte`
- Test: `tests/vitest/structure/external-history.test.ts`
- Test: `tests/vitest/trajectory/supercell-history.test.ts`

- [ ] Add failing tests for external entries without structure snapshots, indexed ledger toggles, current/all restoration, and derived-cache invalidation.
- [ ] Run both tests and verify current history union cannot represent an external token.
- [ ] Add `{kind:'external', history_token}` undo/redo entries. Indexed history toggles the ledger entry; in-memory history restores immutable frame references; both paths use transaction invalidation and republish.
- [ ] Re-run tests and commit with `feat(history): undo scoped trajectory edits`.

## Task 6: Export effective frames lazily

**Files:**

- Create: `src/lib/trajectory/effective-frame-export.ts`
- Modify: `src/lib/trajectory/TrajectoryExportPane.svelte`
- Modify: `src/lib/trajectory/Trajectory.svelte`
- Test: `tests/vitest/trajectory/effective-frame-export.test.ts`
- Modify: `tests/playwright/trajectory.test.ts`

- [ ] Add failing tests that visual replication exports base, current-scope affects one XYZ frame, all-scope indexed export resolves every frame lazily, no preloaded slice is used, abort produces no partial download, and video waits for publication.
- [ ] Run the targeted tests and verify current slice/export behavior fails.
- [ ] Export through `EffectiveFrameResolver.iterate()`. Await normal frame publication for raster/video; abort before download on any failure.
- [ ] Re-run tests and commit with `fix(export): resolve scoped trajectory frames`.

## Task 7: Scoped Build acceptance

- [ ] Run all new supercell/ledger/transaction/history/export Vitest files plus existing frame-loading, pane-isolation, and bond-cache tests.
- [ ] Run `pnpm exec playwright test tests/playwright/structure/lattice.test.ts tests/playwright/trajectory.test.ts --workers=1`.
- [ ] Test `dump.traj`: view rejects Build; current changes only captured frame; all lazily changes frames; scrub during transform cannot retarget; undo/redo and indexed XYZ are correct.
- [ ] Run `pnpm check` and commit with `test(trajectory): verify true supercell scope`.

