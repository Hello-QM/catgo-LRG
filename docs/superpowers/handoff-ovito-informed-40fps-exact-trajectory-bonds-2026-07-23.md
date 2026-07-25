# Handoff — OVITO-informed 40 FPS exact trajectory bonds

Date: 2026-07-23 PDT  
Status: **PAUSED at the Task 7 review checkpoint because the user needed to shut down.**  
Worktree: `/home/james0001/project/catgo-LRG/.claude/worktrees/traj-round4`  
Branch: `feat/impostor-bond-mvp`  
Required starting commit: `602ffed61dcf59a2b1f49d964d8b83d12f599edd`  
Current implementation HEAD before this handoff commit:
`0d41a999aaea2d79efe5ae824661d8173716f138`

Do not work from another checkout. Do not reset, clean, stash, rebase, or discard this
branch. Do not start/stop the shared `:8000` backend from a worktree agent.

## Governing request

Execute this plan task by task with `superpowers:executing-plans` and strict TDD:

`docs/superpowers/plans/2026-07-23-ovito-informed-40fps-exact-trajectory-bonds.md`

The required design sources are:

- `AGENTS.md`
- `docs/superpowers/specs/2026-07-23-exact-smooth-trajectory-bond-pipeline-design.md`
- `docs/superpowers/specs/2026-07-23-ovito-informed-40fps-exact-trajectory-bonds-design.md`
- the implementation plan above

The user explicitly authorized multiple subagents. Keep one writer per sequential task;
parallelize read-only specification and correctness reviews after a task commit.

The reference trajectory is:

```text
/home/james0001/Downloads/dump.traj
SHA-256: 38d4554e93744b7efc53e2add4f7ef90ed8f72557b78e45f0696347434b3e41c
Shape: 100 frames × 19,968 atoms
```

Never modify or stage:

- `.claude/gate-approvals/`
- `.claude/tmp-dump.traj`
- `.superpowers/`

Every shell command in this repository must be prefixed with `rtk`, per
`/home/james0001/.codex/RTK.md`. Use `apply_patch` for edits.

## Current Git state

Before writing this handoff, `git status --short` contained only:

```text
?? .claude/gate-approvals/
?? .claude/tmp-dump.traj
?? .superpowers/
```

There are no uncommitted source or test changes. The two Task 7 read-only review agents
were interrupted before returning results. No implementation agent remains active.

Commits since the required starting point:

```text
4a6ada76 docs: attribute OVITO bond impostor code
328eaeae feat: add static atom color texture
5f8891f8 perf: compact visible bond topology
e74d24ce test: cover bond color resource lifecycle
e5088f14 perf: compact bond picker topology
2b90ddaf feat: enforce trajectory bond session identity
3582b1e6 fix: preserve trajectory bond segment identity
f5a97cab fix: suppress stale trajectory source loads
10e2ee42 perf: reuse exact neighbor search workspace
44ea55ce test: lock neighbor workspace byte order
0d41a999 feat: add exact Rust trajectory bond session
```

## Completed work

### Tasks 1–5 — complete and reviewed

- Task 1: OVITO attribution and shader provenance.
- Task 2: static atom-color texture.
- Task 3: compact visible bond topology plus color-resource lifecycle coverage.
- Task 4: compact picker topology.
- Task 5: trajectory bond session identity, exact source-specific prepared keys, typed
  length errors, rejection normalization, and same-owner/frame stale-request suppression.

Task 5 fresh verification at closure:

```text
6 focused Vitest files: 70/70 passed
pnpm check: 0 errors, 304 pre-existing warnings
git diff --check: passed
two independent reviews: approved, no findings
```

One previously reported non-blocking Task 2 Minor should be reconsidered in the final
whole-branch review: tests exercise the static color texture behavior but do not explicitly
assert every texture dimension/setting field.

### Task 6 — complete, strengthened, and reviewed

Production commit: `10e2ee42`  
Review-fix commit: `44ea55ce`

Implemented the grow-only `NeighborSearchWorkspace`, exact fully periodic cache key,
open-axis plan rebuilds, reusable occupancy/output/Rayon scratch, deterministic ordered
merge, and legacy cell-list delegation.

Both initial reviewers found that the first parity tests were too circular and too small
to exercise multi-chunk Rayon ordering. The fix:

- pins pre-refactor `f5a97cab` output for a deterministic periodic crystal:
  432 records, 15,552 bytes, digests
  `0xbc13c3dc9921c1c1` and `0x2737ec52e96cd120`;
- uses a 130-atom fixture that always creates three populated 64-center chunks;
- performs a dense warmup before a sparse frame to catch stale retained partials;
- proved test sensitivity with a temporary reversed-merge mutation, producing the expected
  5 passed / 2 failed result before restoring correct production code.

Fresh final Task 6 evidence:

```text
trajectory_workspace_ --no-default-features: 7/7 passed
trajectory_workspace_ default/Rayon: 7/7 passed
neighbors::tests: 53/53 passed
direct neighbors.rs rustfmt check: passed
git diff --check: passed
two re-reviews: approved, no findings
```

The literal manifest-wide `cargo fmt --check` is a proven pre-existing, out-of-scope
failure across thousands of lines and many untouched files. Direct formatting checks on
every changed Rust file pass. Do not format unrelated crate files to hide this baseline.

### Task 7 — implementation complete; review incomplete

Commit: `0d41a999aaea2d79efe5ae824661d8173716f138`

Changed only:

- `extensions/rust/src/trajectory_bond.rs`
- `extensions/rust/src/lib.rs`
- `extensions/rust/src/bonding.rs`

Implemented:

- `TrajectoryBondSession`, serializable cumulative stats, and typed native errors;
- cached atomic-number chemistry, exact cutoff, options, PBC, and grow-only frame/result
  storage;
- direct typed-frame compute through `NeighborSearchWorkspace`;
- a shared exact atom-radii predicate driver used by both legacy and session paths;
- validation before session-state mutation and recovery after malformed frames.

Strict TDD evidence:

```text
RED scalar: exit 101 on missing TrajectoryBondSession/Error/Stats
RED default/Rayon: exit 101 on the same missing API
GREEN scalar trajectory_bond::tests: 11/11
GREEN default/Rayon trajectory_bond::tests: 11/11
legacy bonding::tests: 17/17
direct rustfmt checks on all three touched files: passed
git diff --check: passed
```

The manifest-wide formatter still fails only on the known baseline. A recursive rustfmt
attempt briefly touched module children during implementation; that entire formatting
diff was reverse-applied before the three intended edits were replayed. The final commit
contains exactly the three authorized files and no unrelated formatting.

Two read-only Task 7 reviewers had begun reading the full diff but were interrupted at the
user's stop request. They returned no final assessment. **Resume by completing Task 7
review before marking the task done or starting Task 8.**

## Exact resume procedure

1. Read this handoff, `AGENTS.md`, both design specs, and the full implementation plan.
2. Confirm the branch and clean checkpoint:

   ```bash
   rtk git branch --show-current
   rtk git rev-parse HEAD
   rtk git status --short
   ```

   Expected branch: `feat/impostor-bond-mvp`. Expected HEAD will be this handoff commit.
   Status should show only the three protected untracked paths.

3. Recreate any review artifacts under a fresh `/tmp` directory. The prior
   `/tmp/catgo-traj-round4-sdd.*` reports and briefs may disappear after reboot; do not
   depend on them.
4. Run a fresh Task 7 verification:

   ```bash
   rtk cargo test --manifest-path extensions/rust/Cargo.toml \
     trajectory_bond::tests --no-default-features
   rtk cargo test --manifest-path extensions/rust/Cargo.toml \
     trajectory_bond::tests
   rtk cargo test --manifest-path extensions/rust/Cargo.toml \
     bonding::tests
   rtk git diff --check
   ```

5. Launch parallel read-only Task 7 reviews:

   - formal plan/spec compliance;
   - Rust semantic audit focused on exact predicate parity, scalar/Rayon order,
     non-periodic padded-lattice semantics, validation-before-mutation, error recovery,
     capacity counters, and test blind spots.

   If a finding is valid, return it to a sole writer, use a failing regression/mutation
   test first, commit the fix, and re-review the bounded fix.

6. After Task 7 is approved, continue sequentially:

   - Task 8: persistent WASM bond session and worker/runtime diagnostics.
   - Task 9: prepared-frame diagnostics exposure.
   - Task 10: raise and pass the real headed hardware gate.

7. Do not stop at unit tests. Task 10 must continue through measured contingency work until:

   - all 100/100 displayed bond graphs exactly match the independent reference;
   - first and steady playback segments each reach at least 40 unique presented FPS;
   - the headed RTX 4060 WebGL context, compact payload, bounded memory, cache, seek,
     session reuse, threading, and GL assertions all pass.

8. After the real gate passes, run every final gate from the plan:

   ```bash
   rtk pnpm verify:wasm
   rtk cargo test --manifest-path extensions/rust/Cargo.toml --lib
   rtk pnpm test
   rtk pnpm check
   rtk python -m pytest
   rtk git diff --check
   rtk git status --short
   ```

   Then run the final whole-branch review and the
   `superpowers:finishing-a-development-branch` workflow.

## Remaining plan status

```text
Tasks 1–6: complete and reviewed
Task 7: implementation committed; fresh verification and reviews still required
Task 8: not started
Task 9: not started
Task 10: not started; no new 40 FPS headed gate has been run
Final whole-branch verification/review: not started
```

No real-file performance claim should be made from this checkpoint. The mandatory
100/100 exactness and dual-segment ≥40 FPS result remains outstanding.
