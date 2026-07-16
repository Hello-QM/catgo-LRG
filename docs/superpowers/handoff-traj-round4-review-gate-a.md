# Handoff — traj-round4 review closure → Gate A

Date: 2026-07-16
Status: **GATE A PASS — production trajectory packet wired; real interval Play passes**

This is the current durable handoff. The older Play-crash history remains in
`docs/superpowers/handoff-impostor-play-crash.md`; use this file for current execution
state and `.superpowers/sdd/progress.md` for the detailed ledger.

## Resume location

```text
Worktree: /home/james0001/project/catgo-LRG/.claude/worktrees/traj-round4
Branch:   feat/impostor-bond-mvp
HEAD:     49e8546a fix(webgl): wire trajectory replica packets into scene
Divergence from origin/main at final Gate A: 0 behind / 70 ahead
```

Do not work from the repository root checkout. Do not push, open a PR, merge, or manage
the shared `:8000` backend without explicit user instruction.

## User directives that govern continuation

1. Progress/review state must be written to `.superpowers/sdd/progress.md` as it happens.
   Unrecorded work is not complete.
2. Finish every work session with a durable handoff. No handoff means incomplete.
3. Stop review loops. Use at most one initial independent review per unfinished task.
   After fixes, use targeted regression tests + typecheck/build evidence + Gate A/B/C.
   Do not send already-clean work through another reviewer.
4. Subagents use highest available tier (Fable in this session).
5. Never start/stop the shared `:8000` backend from worktree agents.

Persistent preference memories:

- `feedback_durable_ledger_handoff.md`
- `feedback_no_review_loops.md`
- `feedback_subagent_model.md`
- `feedback_subagent_no_pkill_shared_services.md`

## Git/worktree snapshot

At handoff, HEAD is `01f438d2`; two implementation agents have uncommitted in-flight
changes. Do not discard, reset, stash, clean, or overwrite them.

```text
 M src/lib/structure/gpu/bond-compute.ts
 M src/lib/structure/gpu/bond-compute.wgsl.ts
 M src/lib/structure/gpu/large-system-renderer.ts
 M tests/vitest/structure/gpu/bond-compute-pack.test.ts
 M tests/vitest/structure/gpu/webgl2-replica-atoms.test.ts
 M tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts
 M tests/vitest/structure/gpu/webgl2-replica-managers.test.ts
 M tests/vitest/structure/gpu/webgpu-render-packet.test.ts
```

Likely ownership at handoff:

- Visual T3 fixer: `bond-compute.ts`, `bond-compute.wgsl.ts`,
  `large-system-renderer.ts`, `bond-compute-pack.test.ts`,
  `webgpu-render-packet.test.ts`.
- Visual T4 fixer: the three `webgl2-replica-*.test.ts` files; production WebGL2 files
  may be edited later before its commit.

These agents were still running when this handoff was written. If the session dies,
FIRST inspect Git and reports for landed commits before redispatching. Background agents
may have completed after this snapshot.

## Closed review items

### WASM build hygiene — CLOSED

Commits: `fcc0944c` + `7fc2ab95`.

- Initial review: Spec PASS; 0 Critical, 0 Important, 1 deferred Minor.
- Focused Node tests: 12/12 PASS.
- Artifact verifier: PASS; all six bridge files byte-identical.
- `bash -n deploy/hpc/build.sh`: PASS.
- Durable result: `.superpowers/sdd/wasm-build-hygiene-review-result.md`.

Deferred Minor: duplicate selector mixed-form behavior is manually verified but lacks one
automated regression case. Do not reopen unless touching that test again.

### Build T6a lazy effective-frame export — CLOSED

Commits: `94b60983` + `8dc70f92`.

- Review: Spec PASS; 0 Critical/Important/Minor.
- Targeted tests: 8/8 PASS.
- Full trajectory evidence: 490 PASS, 1 pending.
- Durable result: `.superpowers/sdd/build-task-6a-review-result.md`.

### Integration deterministic fixture — CLOSED

Commits: `ebad20fa` + fix `416fc96f`.

- Initial finding: raw-byte checksum unstable on Windows CRLF checkout.
- Fix: `.gitattributes` pins
  `tests/fixtures/trajectory/*.extxyz text eol=lf`.
- Re-review completed before review-loop policy correction: Spec PASS,
  0 Critical/Important/Minor.
- Windows checkout simulation preserved expected SHA-256.
- Focused Vitest: 1/1 PASS.
- Durable result: `.superpowers/sdd/integration-fixture-review-result.md`.

### Bonds T7a benchmark acceptance — CLOSED

Commits: `7e9a31ca` + `ab1e2c70` + fix `01f438d2`.

- Initial finding: transitive `pkg-scalar` import failure could fall back to stale legacy
  `pkg` and false-pass with `STATUS: DONE`.
- Fix: fallback only for exact scalar entry JS/WASM absence; transitive import/init
  failures are fatal.
- Focused Vitest: 21/21 PASS.
- `node --check`: PASS.
- Real 19,683-atom benchmark: `STATUS: DONE`; TTT ratio 0.394, FFF ratio 0.475;
  parity/determinism PASS.
- Re-review completed just before cancellation: Spec PASS, 0 findings.
- Durable result: `.superpowers/sdd/bonds-task-7a-review-result.md`.

Do not review any closed item again.

## Closed item: Visual T3 WebGPU packet ownership

Initial implementation commits: `cefd5e99` + `003b10d2`.
Fix commits: `2904bc35` + cleanup `2bd47418`.
Initial review result: `.superpowers/sdd/visual-task-3-review-result.md`.
Fix evidence: `.superpowers/sdd/visual-task-3-report.md`.

Blocking findings being fixed:

1. Packet `BaseBondGraph` jimages were silently clamped to `[-1,1]`; full declared signed
   range must be preserved or unsupported values must fail/reroute explicitly.
2. Ghost-complete bonds used the actual bond graph while sparse ghost atoms came from
   decorative boundary metadata. Both must derive from the same `BaseBondGraph`.
3. `set_bond_data()` could overwrite packet-owned render lattice without ownership
   invalidation/restoration.

Deferred Minor: async pick decodes against mutable post-submit replica layout/image state.
Handle during picking integration; do not expand current fix unless required by code.

Closure evidence under no-review-loop policy:

- Full signed Int8 jimages preserved across TypeScript/WGSL packing; regression covers
  `+2`, `-3`, `-128`, and `+127`.
- Packet and GPU-generated sparse ghosts derive from the same active `BaseBondGraph`;
  decorative image metadata plumbing removed by cleanup commit.
- Packet-owned bond render lattice is isolated from legacy detector updates.
- Focused WebGPU/bond Vitest: 29 PASS / 6 skipped; cleanup focused Vitest: 11 PASS.
- `pnpm check`: 0 errors / 305 pre-existing warnings. No repeat reviewer launched.
- Deferred unchanged Minor: async pick request-time layout/image snapshot.

## Closed item: Visual T4 production integration

Initial commits: `70900add` + `8b7385ba` + `d38baf5c`.
Primary fix commit: `0b277972 fix(webgl): harden replica pass state and ghost buffers`.
Initial review result: `.superpowers/sdd/visual-task-4-review-result.md`.
Fix evidence: `.superpowers/sdd/visual-task-4-report.md` — focused 33/33 PASS;
`pnpm check` 0 errors / 305 warnings. Final viewport fix: `ffa14e63
fix(webgl): preserve pass viewport across divisor reset`; manager RED 1/4 then GREEN
4/4, combined focused 33/33 PASS, `pnpm check` 0 errors / 305 warnings.

Blocking findings being fixed:

1. Lattice-only packet change could leave atom/bond `uLattice` stale.
2. Divisor-rebind path used canvas viewport/scissor getters and could overwrite active
   render-target pass state under real Three r181 semantics.
3. `ghost-images` factor cycles replaced sparse ghost attributes/WebGLBuffers instead of
   reusing identity-stable growable resources.
4. A late reviewer already running before the review-loop cancellation found divisor-reset
   frames still upload stale `uViewport`: GL state is restored, but Three r181's separate
   `_currentViewport` bookkeeping is not, so post-reset `getCurrentViewport()` returns the
   render-target viewport. Capture the pass viewport before reset and reuse it for main and
   ghost bond draws; split fake renderer bookkeeping-vs-GL viewport state in regression.

Closure:

- Original three findings closed by `0b277972`; late viewport finding closed by
  `ffa14e63` using pre-reset pass capture shared by main and ghost draws.
- Focused atom/bond/manager Vitest: 33/33 PASS; manager viewport regression: 4/4 PASS.
- `pnpm check`: 0 errors / 305 pre-existing warnings; `git diff --check`: PASS.
- No repeat reviewer launched. Gate A is runtime acceptance.
- Real Gate A exposed that these components were not wired into production. Final integration
  commit `49e8546a fix(webgl): wire trajectory replica packets into scene` activates the
  packet path from trajectory 1×, keeps scientific structure base-sized, routes visual dims
  independently of WebGPU mode, constructs one manager-ready packet from current colors/
  radii/final copied bond-manager graph, and passes it to both managers.
- Production RED source contract: 11 PASS / 1 expected FAIL; GREEN: 7 files, 152/152 PASS;
  `pnpm check` 0 errors / 304 warnings. Durable report:
  `.superpowers/sdd/visual-task-4-production-wiring-report.md`.

## Build T4 state

Commit: `d58cd695` — scoped trajectory supercell transactions.
Recovered report: `.superpowers/sdd/build-task-4-report.md`.
Diff package: `.superpowers/sdd/build-task-4-final-review.txt`.

- Focused Vitest: 29/29 PASS.
- Named Playwright grep returned `No tests found`; those tests are outside configured
  `testDir` and marked `test.fixme`. Do not report them as PASS.
- Broad reviewer was canceled under user token-saving directive before producing findings.
- Do not restart review. Validate runtime behavior through Gate A, then later Build scope
  acceptance tasks.

## Gate A — PASS

Gate A initially failed because T4 component code was not wired into production; the real
scene stayed on legacy `InstancedMesh`, froze replica positions, and rendered chaotic bonds.
That failure is fixed by `49e8546a`, then the complete real-UI matrix was rerun.

Evidence:

- Isolated frontend: `VITE_STATIC_ONLY=true`, port 3457; shared `:8000` untouched.
- Exact prior failing CatGo example: `vasp-XDATCAR-traj.gz`, 100 frames, 76 base atoms.
  At 2×2×2 the packet atom draw is 608 instances; the old 608/76 frozen-slot warning is
  gone and screenshot shows orderly attached bonds.
- Frames 5→99→5: packet atom count stayed 608; bond half-counts 4160→4112→4160;
  packet mesh UUIDs stayed stable; `isContextLost=false`, `gl.getError()=0`.
- Real interval Play at 2×2×2 advanced frames 40→54 and 70→76. Repeated Play/Pause worked;
  no shader error, `INVALID_OPERATION`, context loss, NaN, blank viewer, or detached bonds.
- Factor cycle 1×→2×→8×→1× kept packet mesh UUIDs stable. Atom counts
  76→152→608→76 and sampled bond counts 488→976→3904→488. No visible legacy render
  `InstancedMesh`; only named transparent picking hitboxes remained.
- Exact `/home/james0001/Downloads/dump.traj` loaded once through the real trajectory drop
  handler. At explicit 1×: 19,968 atoms; frame 5/99/5 bond half-counts
  52,092→51,896→52,092. Real Play sampled frames 57→72 with stable 19,968 atoms,
  live ~50.8k bond halves, one visible canvas, `isContextLost=false`, `gl.getError()=0`.
- Console contained only unrelated static-browser noise: WebGPU no-adapter warning, one 404,
  and desktop-only filesystem error. Threaded ferrox worker initialized with 8 threads.
- Screenshots archived under `$CLAUDE_JOB_DIR/tmp`:
  `gate-a-xdatcar-fixed-frame0-8x.png`, `gate-a-xdatcar-fixed-playing-8x.png`,
  `gate-a-dump-fixed-playing.png`; pre-fix comparison `gate-a-small-8x.png`.

Non-blocking follow-ups: replica-specific picking remains deferred; transparent base picking
hitboxes remain. In-place trajectory replacement inherited the prior supercell label until
explicit reset; accepted large-file evidence was collected after explicit 1×. Production
Vite build still has the separate worker `iife`/code-splitting issue.

Run FE-only on an isolated port. Never run `desktop:serve`; never start/stop shared
`:8000`. Prefer STATIC_ONLY build or isolated frontend launch so backend noise cannot
unmount the viewer.

Required runtime matrix:

1. Clean GPU/browser process.
2. Load small `scratchpad/npt-varcell.extxyz` first.
3. Exercise real interval **Play**, not programmatic scrub only.
4. Verify frame 5/99 and 5→99→5.
5. Play/pause repeatedly.
6. Switch factors 1× → 2× → 8× → 1×.
7. Confirm one visible canvas/draw path; no hidden legacy `InstancedMesh` behavior.
8. Check console for shader errors, `INVALID_OPERATION`, `CONTEXT_LOST_WEBGL`, NaN,
   stale lattice, broken ghost bonds, or blank viewer.
9. Then load exact large `.claude/tmp-dump.traj` / user `dump.traj` once on a clean GPU;
   avoid repeated drop/reload that poisons the Chrome GPU process.
10. Capture screenshots, console evidence, renderer diagnostics, and result paths.

Original unresolved runtime risk remains: impostor interval Play previously lost WebGL
context for both small and large systems while scrub worked. No current fix may be called
successful until real Play passes.

Gate A source: `.superpowers/sdd/progress.md:249-261`.
Historical crash analysis: `docs/superpowers/handoff-impostor-play-crash.md`.

## Exact next steps

Gate A and the reopened Visual T4 production integration are closed. Do not reopen or
redispatch them without a new runtime regression.

1. Commit this final durable handoff update; verify worktree clean.
2. Stop only the controller-owned isolated port-3457 frontend when this session finishes;
   never manage shared `:8000`.
3. Await user direction before continuing remaining Visual/Build/Bonds plan tasks, pushing,
   opening a PR, merging, or running broad final review.
4. Tracked follow-ups for later scopes:
   - replica-specific picking/request-time codec snapshot;
   - trajectory replacement supercell-label inheritance/reset behavior;
   - production Vite threaded-worker `iife`/code-splitting build failure;
   - remaining plan tasks and Gate B/C.

## New-session recovery prompt

```text
Work only in:
/home/james0001/project/catgo-LRG/.claude/worktrees/traj-round4

Read first:
1. .superpowers/sdd/progress.md
2. docs/superpowers/handoff-traj-round4-review-gate-a.md
3. git status + recent git log

Use disk + Git as truth. Do not redispatch closed reviews. Inspect whether Visual T3/T4
fix agents left commits/reports after the handoff snapshot. Resume the first unfinished
step under "Exact next steps". Record every result immediately. Do not start/stop :8000,
push, merge, reset, clean, stash, or discard in-flight changes.
```

## Update — Visual T3 closed (2026-07-16)

Visual T3 is CLOSED by commit `2904bc35`
(`fix(webgpu): preserve packet bond graph ownership`). All three Important
findings are covered: full signed Int8 jimage packing, bond/ghost publication
from one `BaseBondGraph`, and detector/render lattice ownership separation.
Focused WebGPU/bond Vitest: 29 passed, 6 skipped (4 files passed, 1 skipped).
`pnpm check`: 0 errors, 305 pre-existing warnings. Scoped `git diff --check`:
PASS. Exact commands and results are appended to
`.superpowers/sdd/visual-task-3-report.md`; progress closure is appended to
`.superpowers/sdd/progress.md`. No repeat reviewer was launched.

Remaining Gate A blocker: Visual T4 dirty work must finish and commit; then the
worktree cleanup/status gate can proceed. The deferred T3 Minor remains async
pick request-time codec/layout capture during Visual picking integration.
