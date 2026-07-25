# Trajectory Supercell Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the fast bond, GPU visual-supercell, and true Build-supercell work without semantic regressions, then prove correctness on the exact 100×19,968 trajectory.

**Architecture:** Feature units merge only through typed seams: `RenderPacket`, `BondDispatchPlan`/`TypedBondTable`, `SupercellOp`, and `EffectiveFrameResolver`. Integration tests force both render backends and all edit scopes while reading diagnostics instead of relying only on screenshots.

**Tech Stack:** Vitest, Playwright, Chromium WebGPU/WebGL2, Svelte check, Vite production build.

## Global Constraints

- Use `tests/e2e`, because the default Playwright configuration does not run legacy `tests/playwright` as CI E2E coverage.
- The exact dump file is local/gated and must not be committed.
- WebGPU cases may skip only when the capability probe truly fails; forced WebGL2/WASM is mandatory.
- 60 FPS is reported, not a completion gate for this round.

---

## Task 1: Lock the shared interfaces before integration

**Files:**

- Modify: `src/lib/structure/scene/render-packet.ts`
- Modify: `src/lib/structure/workers/bond-backend-policy.ts`
- Modify: `src/lib/structure/supercell-operation.ts`
- Modify: `src/lib/trajectory/effective-frame-resolver.ts`
- Test: `tests/vitest/structure/integration-contracts.test.ts`

- [ ] Add compile/runtime assertions that renderer adapters consume the same packet, visual factor changes do not invalidate bond detection, true Build uses `SupercellOp`, and every trajectory consumer resolves effective frames.
- [ ] Run `pnpm exec vitest run tests/vitest/structure/integration-contracts.test.ts --reporter=verbose`; verify incomplete seams fail.
- [ ] Remove duplicate adapter-local versions and make all integration call sites consume the canonical types.
- [ ] Re-run and commit with `refactor(structure): unify trajectory render seams`.

## Task 2: Add deterministic fixtures and diagnostics

**Files:**

- Create: `tests/fixtures/trajectory/supercell-small.extxyz`
- Create: `tests/e2e/helpers/renderer-diagnostics.ts`
- Modify: `src/lib/structure/Structure.svelte`
- Modify: `src/lib/trajectory/Trajectory.svelte`

- [ ] Expose DEV/test-only diagnostics for active renderer, base/instance atoms and bonds, graph/packet versions, dispatches, capacities, worker backend/count, current frame owner, operation ledger revision, provenance, and live resources.
- [ ] Add a small variable-cell/variable-N deterministic fixture covering a periodic self-edge and a scope-changing topology edit.
- [ ] Unit-test diagnostics snapshots and commit with `test(structure): expose backend diagnostics`.

## Task 3: Cross-backend and cross-scope E2E

**Files:**

- Create: `tests/e2e/trajectory-supercell-integration.spec.ts`

- [ ] Test visual 1×/2×/8× through seek/play/scrub in auto, forced WebGPU, and forced WebGL2/WASM policies.
- [ ] Assert N-sized CPU topology/positions, factor-scaled draw instances, unchanged bond dispatch/capacity on factor-only updates, attached periodic endpoints, base-site picks, and one active canvas.
- [ ] Test Build `view`, `edit-current`, and `edit-all`; scrub during staging; undo/redo; per-frame cell; indexed effective XYZ export; visual scientific export stays base.
- [ ] Test WebGPU device-loss and worker-failure injection retains the last complete scene and owner.
- [ ] Run `pnpm exec playwright test tests/e2e/trajectory-supercell-integration.spec.ts --workers=1` and commit with `test(supercell): integrate render and edit semantics`.

## Task 4: Exact dump.traj matrix and resource gate

**Files:**

- Create: `tests/e2e/dump-traj-supercell.spec.ts`

- [ ] Fail fast when `DUMP_TRAJ` is requested but missing; upload `/home/james0001/Downloads/dump.traj` via Playwright without copying it into the repository.
- [ ] Verify 100 frames, N=19,968, user-visible frames 5 and 99, 5→99→5 checksum identity, play/pause/scrub, factors 1/2/8, and both backend policies.
- [ ] Assert no blank frame, stale owner, NaN, OOB endpoint, context loss, duplicate visible canvas, or >500 ms main-thread task during factor switches/random seeks.
- [ ] Run three 1×→2×→8×→1× and ten 5↔99 cycles; assert canvas/device/buffer/worker/listener/timer counts do not monotonically grow.
- [ ] Record FPS and WebGPU timing splits without gating on 60 FPS.
- [ ] Run `DUMP_TRAJ=/home/james0001/Downloads/dump.traj pnpm exec playwright test tests/e2e/dump-traj-supercell.spec.ts --workers=1` and commit with `test(trajectory): verify exact supercell matrix`.

## Task 5: Final verification and review

- [ ] Run all new targeted Vitest files from the three implementation plans.
- [ ] Run `pnpm exec vitest run tests/vitest/trajectory tests/vitest/structure --reporter=dot`.
- [ ] Run `pnpm check`; require 0 errors and record pre-existing warnings separately.
- [ ] Run `pnpm run build` and `pnpm build:wasm` plus artifact verification.
- [ ] Run exact dump E2E once with WebGPU available and once forced WebGL2/WASM.
- [ ] Request independent code review focused on partial graph publication, stale owner races, CPU N×C allocations, operation ordering, export semantics, and worker/device cleanup.
- [ ] Fix all confirmed findings and repeat affected gates before declaring completion.

