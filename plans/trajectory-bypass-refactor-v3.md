# Plan v3 — Trajectory Bypass Refactor (Architecture P)

**Branch:** atom-soa-refactor (HEAD at completion: `c8d75b55`)
**Status:** SHIPPED (2026-04-26) — all 7 phases implemented across C1-C6 + Phase 7 via I1 (commit `01191257`)
**Architecture decision:** P (position-only-write) — see `plans/W6-architecture-decision.md`
**Implementation commits:**
- C1 `492446a0` — Phase 1: atom_manager lift + atom_positions_buffer routing
- C2 `a9717e86` — Phase 2: position-write loop + vibration mutex
- C3 `846e7c53` — Phase 3: bond fast-path + __bbp_prev_traj guard
- C4 `d4249cbd` — Phase 4+5: pivot + writeback (mandatory single commit)
- C5 `b2f2ee61` — Phase 5.5: X2 early-return gate
- C6 `f01762b5` — Phase 6: delete all 5 patch categories
- Phase 7 already shipped via I1 commit `01191257` (prewarm_bond_worker)

**Follow-up fixes shipped during smoke testing:**
- `f37fd473` — pencil fragment-add fires on_atom_added (W5 follow-up)
- `681c593e` — I5 charge label position fix (architectural-P consumer pattern)
- `b848fe42` — W7 Milestone 4 partial: Test 8.4 + FIXTURE_192A_20F + Milestone 5 plan
- `70c5befc` — selection highlight follows atoms during playback (third instance of the same pattern)
- `c8d75b55` — docs the GPU picker hit-test deferred follow-up

**Reversibility:** every phase commit is independently revertable to a shippable state, OR is explicitly merged with adjacent phase(s) into a single-commit boundary. Verified via the live `d94071e0` revert during smoke testing — shipped commits remain green after reverting unrelated follow-ups.

**Empirical verification:** all W1 cascade-silence invariants verified at C6 manual smoke test on 878-atom trajectory. atom_data_fires=0, bbp_meaningful=0, x2_*=0, acb_fires=0, nhsi_fires=0 during playback. Per-frame work flows exclusively through `atom_manager.set_position` (Phase 2) → `apb_fires` increments + `bbp_fires` (trajectory branch absorbs) — both by-design under Architecture P.

**Synthesis source:** integrated from three independent drafts (implementer, rollback-safety, verification lenses) plus W1-W8 inputs

---

## Why v3 replaces v2

v2 proposed a snapshot architecture (Structure.svelte freezes `displayed_structure` into `__topology_snapshot` during playback). Three independent reviewers identified failure modes:

1. **Asymmetric state.** v2's snapshot freezes only StructureScene's view, leaving Structure.svelte's own `ctx_constraints_section` (`Structure.svelte:1475`), `ctx_charge_label_section` (`Structure.svelte:1483`), and `AtomLegend.has_charges` (`AtomLegend.svelte:82`) cascading on live data per frame. Architectural smell that future contributors will silently violate.
2. **Unimplementable T2.3 dev-mode assertion.** v2 proposed a `console.warn` inside `atom_data $derived` body — but `$derived` is pure and can't observe parent state.
3. **Writeback contract failure.** v2's deep-mutation T5 writeback doesn't propagate through Svelte 5's `$bindable`.
4. **Component topology error.** v2 placed the position-write loop in Trajectory.svelte, but Trajectory is the PARENT of Structure.svelte and cannot receive props from it.
5. **Only 1 of 5 patch categories deletable** under v2.

**v3 adopts Architecture P.** `displayed_structure` stays quiescent throughout playback — the entire reactive graph outside the GPU fast-paths is silent. All 5 patch categories deletable. The W2 writeback uses full-object reassignment (the established pattern at `Structure.svelte:1142`). The W1 detector uses module-level `let` counters (already prototyped at `__atom_data_fast_count`). The position-write loop lives in Structure.svelte, not Trajectory.svelte.

---

## Pre-Phase verification checklist

Run before Phase 1:

```bash
# 1. Confirm branch and HEAD
git rev-parse --abbrev-ref HEAD          # must print: atom-soa-refactor
git log --oneline -5
# Must show 2da95947 (W5 design) at top, with 54705594 (W1.2 baseline) and
# 2a3ac13f (W1.1 probe) earlier in history.

# 2. Confirm W7 Milestone 1 + 2 test infrastructure exists
ls src/routes/test/structure-trajectory/+page.svelte
ls tests/playwright/structure-trajectory.test.ts
ls tests/playwright/structure-trajectory.test.ts-snapshots/

# 3. W7 Categories 1 + 7 partial pass on current HEAD
pnpm exec playwright test tests/playwright/structure-trajectory.test.ts
# Expected: 8 passed (5 from Cat 1 + 3 from Cat 7)

# 4. Confirm W1 probe fires loud (manual smoke test)
# Open http://localhost:3005/test/structure-trajectory in DevTools
# Run:
#   window.__catgo_probe.reset()
#   setTimeout(() => console.log(JSON.stringify(window.__catgo_probe.snapshot())), 5000)
# Click play. After 5s, verify ALL of:
#   atom_data_fires > 0   (cascade active — confirms W1 detects regressions)
#   bbp_meaningful > 0    (build_bond_pairs fires per frame on baseline)
#   apb_fires > 0         (atom_positions_buffer allocates per frame)
#   acb_fires > 0         (atom_colors_buffer allocates per frame)
# These are the LOUD baseline. If all are 0, the probe is mis-wired.

# 5. Idle false-positive check
#   window.__catgo_probe.reset()
#   wait 5s without playing
#   window.__catgo_probe.snapshot()
# All counters should be 0 (or at most 1-2 from one-time topology init).

# 6. Type check baseline
pnpm check 2>&1 | grep -c "error"        # 5 pre-existing errors documented in MEMORY.md

# 7. All W-item documents present
ls plans/W1-cascade-detector-design.md
ls plans/W2-bindable-writeback-verification.md
ls plans/W3-displayed-structure-audit.md
ls plans/W4-atom-manager-lift-audit.md
ls plans/W5-resume-disable-design.md
ls plans/W6-architecture-decision.md
ls plans/W6-review-recommendation.md
ls plans/W6-review-sequencing.md
ls plans/W6-review-completeness.md
ls plans/W7-trajectory-test-suite-design.md
ls plans/phase4-current-structure-investigation.md
```

---

## Phase commit boundaries

The 8 W6-numbered phases are committed as **6 separate commits**, with one mandatory merger:

| Commit | Phases | Why merged |
|---|---|---|
| C1 | Phase 1 (atom_manager lift + atom_positions_buffer fix) | Independent |
| C2 | Phase 2 (position-write loop) | Independent (additive — old path still active) |
| C3 | Phase 3 (bond fast-path) | Independent (additive — old path still works) |
| **C4** | **Phase 4 + Phase 5 combined** | **MANDATORY MERGE** — between Phase 4 and Phase 5, drag-commit during pause writes frame-0 positions instead of paused-frame positions. Test 2.3 fails in that window. Single-commit boundary is the only safe one. |
| C5 | Phase 5.5 (X2 gate) | Independent — 1-LOC change, hard pre-condition for C6 |
| C6 | Phase 6 (delete patches) | Independent — large deletion (~150 LOC), benefits from its own review |
| C7 | Phase 7 (worker prewarm) | Independent — additive, low-risk |

Phase 0 (W1 probe) is already shipped at commit `2a3ac13f`.

**Recommended git tagging:** tag every phase commit with `v3-traj-bypass-phase-N <hash>` immediately after push. This makes `git revert <tag>` unambiguous during incident response.

---

## Critical constraints integrated from W6 reviews

These corrections to v2 must be in v3:

| Source | Finding | Integrated as |
|---|---|---|
| Reviewer 1 H1 | W3 missed `atom_positions_buffer` (line 2756) and `atom_colors_buffer` (line 2771) | W1 probe extended to cover them (already done in commit `b8bb6ad6`); Phase 1 fixes `atom_positions_buffer` to read from `atom_manager.positions_buffer` |
| Reviewer 1 H2 | Phase 3's `bond_pairs` wiring is to bond hitbox, not bond renderer; bonds would freeze under P | **Phase 1 includes the `atom_positions_buffer` routing fix** so `BondManagerInstances` automatically follows per-frame writes from Phase 2 |
| Reviewer 1 H3 | Phase 2 double-write timing hazard | Documented in Phase 2 spec; `Math.fround` no-op in `set_position` makes both orderings safe (single GPU upload per frame regardless of which writer fires first) |
| Reviewer 2 HIGH | `stable` memo guard at `StructureScene.svelte:1563` missing `__bbp_prev_traj` | Phase 3 adds `__bbp_prev_traj` tracking |
| Reviewer 2 HIGH | Phase 2 deliverable says position-write loop is in Trajectory.svelte; topology is wrong | Phase 2 spec corrects: loop lives in Structure.svelte (which receives `trajectory_frame_positions` as incoming prop) |
| Reviewer 2 HIGH | Phase 2 "W1 must be silent" calibration error | W1 expectation matrix below shows W1 LOUD at Phase 2 (correct) |
| Reviewer 2 CRITICAL | Phase 6 X2 deletion without prior X2 gate causes 15-30ms/frame regression | Phase 5.5 inserted as mandatory predecessor to Phase 6; Test 8.3 is the hard gate |
| Reviewer 2 HIGH | Phase 4 + Phase 5 must land together | Codified as commit C4 (mandatory merge) |
| Reviewer 3 HIGH | Phase 4 `current_structure` removal scope unresolved | Resolved in `plans/phase4-current-structure-investigation.md`; Phase 4 spec uses `topology_initialized` gate |
| Reviewer 3 HIGH | Vibration-trajectory mutex unverified | Phase 2 adds explicit gate `if (trajectory_frame_positions != null) return` at top of vibration `$effect` (`StructureScene.svelte:1610`) |
| Reviewer 3 HIGH | W2 contract not actually selected | Phase 5 uses Option 1 (full reassignment), verified at all 3 `<Structure bind:structure>` call sites in `plans/W2-bindable-writeback-verification.md` |
| Reviewer 3 MEDIUM | W7 must be authored before phases gate on it | Categories 1 + 7 partial done (commit `a1842479`); per-phase test authoring schedule below |
| Reviewer 3 MEDIUM | W5 detection mechanism unspecified | `plans/W5-resume-disable-design.md` selects Approach A (detection inside Trajectory.svelte's existing handlers); zero new props on Structure.svelte |

---

## W1 probe expectation matrix

**Measurement basis:** 5-second window at hardware-actual fps. Calibrated at the documented baseline reading (15 frames over 5s ≈ 3fps actual; scale by `actual_fps/3` for other hardware). The critical signal is whether a counter is **0** or **non-zero**, not exact magnitude.

All 13 probe counters are listed. **Bold** values are critical phase-success criteria.

| Counter | Baseline (`29420f91`) | Phase 0 (W1 added) | Phase 1 (lift) | Phase 2 (write loop) | Phase 3 (bond fast-path) | Phase 4+5 (pivot + writeback) | Phase 5.5 (X2 gate) | Phase 6 (delete patches) | Phase 7 (prewarm) |
|---|---|---|---|---|---|---|---|---|---|
| `atom_data_fires` | ~15 | ~15 | ~15 | ~15 | ~15 | **0** | 0 | 0 | 0 |
| `atom_data_meaningful` | 0 | 0 | 0 | 0 | 0 | **0** | 0 | 0 | 0 |
| `bbp_fires` | ~17 | ~17 | ~17 | ~17 | ~17 (exits via traj fast-path) | **0** | 0 | 0 | 0 |
| `bbp_meaningful` | ~15 | ~15 | ~15 | ~15 | **0** (Phase 3 success) | 0 | 0 | 0 | 0 |
| `x2_fires` | ~30 | ~30 | ~30 | ~30 | ~30 | ~15 | **0** | 0 | 0 |
| `x2_traj_fast_path_fires` | ~15 | ~15 | ~15 | ~15 | ~15 | ~15 (no-op loop) | **0** | 0 | 0 |
| `x2_slow_meaningful` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `apb_fires` | ~15 | ~15 | ~15 | ~15 (after Phase 1 fix: still ~15 because writes still per-frame) | ~15 | **0** | 0 | 0 | 0 |
| `apb_meaningful` | ~15 | ~15 | ~15 | ~15 | ~15 | **0** | 0 | 0 | 0 |
| `acb_fires` | ~15 | ~15 | ~15 | ~15 | ~15 | **0** | 0 | 0 | 0 |
| `acb_meaningful` | ~15 | ~15 | ~15 | ~15 | ~15 | **0** | 0 | 0 | 0 |
| `nhsi_fires` | ~15 | ~15 | ~15 | ~15 | ~15 | **0** | 0 | 0 | 0 |
| `nhsi_meaningful` | ~15 | ~15 | ~15 | ~15 | ~15 | **0** | 0 | 0 | 0 |

**Critical observations:**

1. **Phase 2 is LOUD by design.** `current_structure` writes still active. The W1 detector MUST fire at Phase 2 — silence at Phase 2 means an accidental Phase 4 pivot.
2. **Phase 3 silences `bbp_meaningful`** (not `bbp_fires`). The trajectory fast-path branch added in Phase 3 returns BEFORE the slow `build_bond_pairs()` call. `bbp_fires` continues at ~17 (subscription to `trajectory_frame_positions` causes re-fires).
3. **Phase 4+5 is the silence pivot** — 11 of 13 counters drop to 0. `x2_fires` and `x2_traj_fast_path_fires` remain non-zero because X2 still subscribes to `trajectory_frame_positions`.
4. **Phase 5.5 silences X2 entirely.** This is the hard gate before Phase 6 — the X2 trajectory_only branch deletion in Phase 6 is unsafe without this gate (slow-path fallthrough at ~15-30ms/frame).
5. **Phase 6 changes nothing in the matrix.** The deletions remove patch code that is already silent post-Phase-5.5. If any counter shifts at Phase 6, a deletion was premature.

---

## W7 test gate matrix

**Legend:** GREEN = must pass. NEW = test must be authored before this phase. UNSKIP = phase removes existing `.skip()` marker.

| Phase | Must be GREEN (regression guards) | New tests turn GREEN | Tests AUTHORED before this phase | Skip markers removed |
|---|---|---|---|---|
| Baseline `2da95947` | 1.1, 1.4, 1.5, 7.1, 7.2, 7.5 | 1.1-1.5, 7.1, 7.2, 7.5 (Milestone 1+2 done) | — | — |
| **C1 — Phase 1** | All baseline | 5.4 (no stale atom count after struct swap) | Milestone 3 partial: tests 5.1, 5.4, 8.1-8.4 (with `.skip()` markers) | — |
| **C2 — Phase 2** | All C1 + 8.1 baseline (`atom_data_fires > 10`) | 1.2, 2.2, 6.1, 7.3 | Milestone 3 cont.: tests 2.1, 2.5, 3.1, 3.3, 6.1 | — |
| **C3 — Phase 3** | All C2 + 7.5 (bonds animate visually) | 1.3, 8.2 (`bbp_meaningful = 0`) | Milestone 3 cont.: tests 3.2, 6.3 | — |
| **C4 — Phase 4+5** | All C3 + 8.3 | 2.3, 2.4, 4.3, 4.4, 5.3, 6.4, 6.5, 8.1 (delta=0 variant) | Milestone 4: tests 2.3, 2.4, 4.3, 4.4, 6.4, 6.5 | 2.3, 2.4, 4.3, 4.4, 6.4, 6.5 |
| **C5 — Phase 5.5** | All C4 + 8.3 (`x2_slow = 0` HARD GATE) | 8.3 stricter | — | — |
| **C6 — Phase 6** | ALL 40 tests | 5.2, 8.4 (strict per-frame cost ≤ 2ms) | Milestone 5 partial: 5.2 | 5.2, 8.4 |
| **C7 — Phase 7** | All C6 + 4.1, 4.2, 7.6 | 4.1, 4.2, 7.6 | Milestone 5 final: tests 4.1, 4.2, 7.6 | 4.1, 4.2, 7.6 |

**8 of 41 W7 tests are already done** (Milestones 1+2: tests 1.1-1.5, 7.1, 7.2, 7.5). 33 tests remain to author. **W7 test authoring time (~14-18h) is co-equal with implementation time (~14-19h).**

---

## Per-phase implementation specifications

---

### Phase 0 — W1 regression detector (already shipped)

**Status:** COMPLETE at commit `2a3ac13f` (probe surface) + `54705594` (W1.2 baseline reading recorded in `StructureScene.svelte:1554-1582`).

**Deliverable:** `globalThis.__catgo_probe` with 13 counters + `snapshot()` / `reset()` API. Test-only getters added in W7 Milestone 1: `get_atom_x(site_id)`, `get_atom_xyz(site_id)`, `atom_count`, `bond_pairs_count`, `filtered_bond_pairs_count`.

**Critical baseline correction documented:** `bbp_meaningful = 15` at baseline (W1 design predicted 0). The `stable` memo guard does NOT absorb trajectory frames at baseline because `struct_ref` changes per frame. Phase 4 success criterion is therefore `bbp_meaningful = 0` AND `bbp_fires = 0`.

---

### Phase 1 — atom_manager lift (W4 Option A) + atom_positions_buffer fix (Reviewer 1 H2)

**Effort:** 2-3 hours (commit C1)

**Deliverable:**
1. `atom_manager` surfaces from StructureScene to Structure.svelte via `$bindable`.
2. `atom_positions_buffer` and `atom_colors_buffer` read from `atom_manager` buffers instead of `structure?.sites`.

**Why fix lands in Phase 1:** Per Reviewer 1 H2, `BondManagerInstances` at `StructureScene.svelte:3595` reads `atom_positions={atom_positions_buffer}`. Without the routing fix, after Phase 4 stops `current_structure` per-frame writes, `structure.sites` stabilizes → `atom_positions_buffer` freezes → bonds visually freeze while atoms animate. Fix must precede Phase 4. `atom_manager` lift is the prerequisite.

**Files changed:**

`src/lib/structure/StructureScene.svelte`:
- Line ~2275: change `const atom_manager = new AtomManager()` to props destructure entry: `atom_manager = $bindable(new AtomManager())`. Default creates a second allocation at mount; Structure.svelte's `$state` value wins via `$bindable` semantics. Document this.
- Line 2756 (`atom_positions_buffer $derived.by`): replace body with read from `atom_manager`:
  ```ts
  const atom_positions_buffer = $derived.by(() => {
    void atom_manager.version  // subscribe — fires on every set_position call
    const count = atom_manager.count
    if (count === 0) return EMPTY_POSITIONS
    const buf = new Float32Array(count * 3)
    buf.set(atom_manager.positions_buffer.subarray(0, count * 3))
    return buf
  })
  ```
- Line 2771 (`atom_colors_buffer $derived.by`): similar — read from `atom_manager.colors_buffer`. Null-guard: if `!atom_manager.has_colors` return `EMPTY_COLORS`.

`src/lib/structure/Structure.svelte`:
- Add `import { AtomManager } from './atoms/atom-manager.svelte'`.
- Line ~169 (after `scene_atom_fast_ops`): `let scene_atom_manager = $state(new AtomManager())`.
- Line ~3361 (`<StructureScene>` template): add `bind:atom_manager={scene_atom_manager}`.

**Order of edits:**
1. Add `AtomManager` import to Structure.svelte.
2. Declare `scene_atom_manager` in Structure.svelte.
3. Add `atom_manager` to StructureScene's `$props()` destructure.
4. Change `atom_positions_buffer` derived.
5. Change `atom_colors_buffer` derived.
6. Add `bind:atom_manager` to `<StructureScene>` template.
7. `pnpm check` — confirm no new errors.
8. Manual smoke test below.

**Verification:**
```bash
pnpm check 2>&1 | grep -c "error"  # no increase from baseline 5
pnpm exec playwright test tests/playwright/structure-trajectory.test.ts
# All 8 currently-passing tests must still pass.
```

**Manual smoke test:**
1. Load `/test/structure-trajectory`. Play trajectory.
2. DevTools: `window.__catgo_probe.atom_manager_count`. Expect 3 (H2O fixture).
3. Verify W1 probe still LOUD: `atom_data_fires ≈ 15`, `bbp_meaningful ≈ 15`, `apb_fires ≈ 15`.
4. **CRITICAL:** if `apb_fires = 0` at Phase 1, the `atom_positions_buffer` fix has accidentally silenced the cascade — that's a Phase 4 leak into Phase 1. Investigate.

**Rollback rehearsal:**
- `git revert <C1>`: StructureScene reverts to local `const atom_manager`. Structure.svelte loses `scene_atom_manager`. `atom_positions_buffer`/`atom_colors_buffer` revert to reading `structure?.sites`. Rendering unchanged from baseline. Atoms visible. Dev server starts. W1 LOUD as baseline.
- **Shippable:** YES.
- **W7 after revert:** GREEN (no behavior change reverted).

**Lockout state during this phase's window:**
- Do not modify: `StructureScene.svelte:2627-2751` (X5/X6 hook closures) — they must stay scene-local per W4.
- Do not introduce: any write to `atom_manager` methods from outside StructureScene — that's Phase 2's scope.

---

### Phase 2 — Position-write loop in Structure.svelte + vibration mutex

**Effort:** 2-3 hours (commit C2)

**Deliverable:** Structure.svelte writes trajectory positions directly to `scene_atom_manager.set_position` per frame. Additive — `current_structure` writes still active. W1 must remain LOUD.

**Component topology correction (Reviewer 2 HIGH):** Loop lives in `Structure.svelte`, NOT `Trajectory.svelte`. Trajectory.svelte is the parent (`Trajectory.svelte:1600` renders `<Structure bind:structure={current_structure}>`). Structure.svelte already receives `trajectory_frame_positions` as an incoming prop at `Structure.svelte:791`.

**Vibration mutex (Reviewer 3 HIGH):** Add to `StructureScene.svelte:1610` (vibration `$effect`) as the first statement: `if (trajectory_frame_positions != null) return`. Without this, vibration writes `realtime_position_overrides` for every atom per rAF tick → trajectory write loop's drag-precedence check skips ALL trajectory writes → silent wrong behavior.

**Files changed:**

`src/lib/structure/Structure.svelte`:
- After `trajectory_active` derived at line 1114, add the position-write `$effect`:
  ```ts
  $effect(() => {
    const mgr = scene_atom_manager
    const traj = trajectory_frame_positions
    if (!mgr || !traj) return
    if (import.meta.env?.DEV && mgr.count > Math.floor(traj.length / 3)) {
      console.warn(
        `[trajectory] Supercell + trajectory: ${mgr.count} slots but cache covers ` +
        `${Math.floor(traj.length / 3)} base atoms. Supercell-extra atoms frozen.`,
      )
    }
    const overrides = realtime_position_overrides
    const max_slot = Math.min(mgr.count, Math.floor(traj.length / 3))
    for (let slot = 0; slot < max_slot; slot++) {
      const sid = mgr.site_ids_buffer[slot]
      if (overrides?.has(sid)) continue  // drag wins
      const base = sid * 3
      mgr.set_position(slot, traj[base], traj[base + 1], traj[base + 2])
    }
  })
  ```

`src/lib/structure/StructureScene.svelte`:
- Vibration `$effect` at ~line 1610 — first line: `if (trajectory_frame_positions != null) return`.

**Double-write safety analysis (Reviewer 1 H3):** `set_position` no-ops on `Math.fround`-equal values. Whichever writer (X2's `trajectory_only` branch or Structure.svelte's new loop) fires first produces the values; the second writes no-ops. Single GPU upload per frame regardless of `$effect` ordering. The H3 timing hazard is performance-only (worst case 2× GPU upload calls in one frame), not correctness.

**Verification:**
```bash
pnpm check 2>&1 | grep -c "error"   # no increase
pnpm exec playwright test tests/playwright/structure-trajectory.test.ts \
  --grep "1\\.|2\\.2|6\\.1|7\\.|8\\.1"
# Tests 1.1-1.5 + 1.2 (atoms move) + 2.2 (drag override) + 6.1 (supercell no crash)
# + 7.1-7.3, 7.5 + 8.1 (cascade still LOUD)
```

**Manual smoke test:**
1. Load trajectory. Play 5 seconds.
2. DevTools: `window.__catgo_probe.snapshot()`. Verify `atom_data_fires ≈ 15` (LOUD — correct).
3. Navigate frame 9. `window.__catgo_probe.get_atom_x(0)` ≈ 1.06. Frame 0: ≈ 0.96.
4. With trajectory playing, attempt to enable vibration if accessible — should be a no-op (vibration `$effect` early-returns).

**Rollback rehearsal:**
- `git revert <C2>`: position-write `$effect` removed from Structure.svelte. Vibration mutex line removed. Atom rendering reverts to X2 trajectory fast-path. No regression.
- **Shippable:** YES.
- **W7 after revert:** GREEN.

**Lockout state:**
- Do not modify: `StructureScene.svelte:2339-2363` (X2 `trajectory_only` branch) — Phase 6 deletes it.
- Do not modify: `Trajectory.svelte:448-468` (frame-advance effect) — that's Phase 4's scope.

---

### Phase 3 — Bond geometry fast-path + `__bbp_prev_traj` memo guard

**Effort:** 2-3 hours (commit C3)

**Deliverable:**
1. `build_trajectory_bond_pairs` is wired into `build_bond_pairs $effect.pre` for per-frame bond geometry.
2. `__bbp_prev_traj` tracking is added to the `stable` memo guard.

**Why `__bbp_prev_traj` is mandatory (Reviewer 2 HIGH):** Phase 3 adds `trajectory_frame_positions` as a reactive dep via the new branch. Svelte fires the `$effect.pre` per frame. The current `stable` check at `StructureScene.svelte:1563-1577` tracks struct, conn, lbs, overrides, drag, sel, overrides_size — but NOT `trajectory_frame_positions`. After Phase 4, `struct_ref` is stable and without `__bbp_prev_traj`, `stable = true` even on traj change → `bond_pairs` not updated → bonds freeze.

**Files changed:**

`src/lib/structure/bond-computation-controller.svelte.ts`:
- Extend `build_trajectory_bond_pairs` signature (currently dead code at line ~258):
  ```ts
  function build_trajectory_bond_pairs(
    connectivity: BondConnectivityEntry[],
    traj_positions: Float32Array,
    overrides: Map<number, [number, number, number]> | null,
    atom_manager: AtomManager,
  ): BondPair[]
  ```
  For each bond endpoint `site_idx`: prefer `overrides?.get(site_idx)`; else if `site_idx < Math.floor(traj.length / 3)` use `traj_positions[site_idx * 3..]`; else use `atom_manager.get_x/y/z(atom_manager.find_slot_by_site_id(site_idx))` for supercell-extra atoms (W6 Open Q4 resolution).

`src/lib/structure/StructureScene.svelte`:
- Add `let __bbp_prev_traj: unknown = null` after the existing `__bbp_prev_*` declarations (~line 1601).
- Add `&& trajectory_frame_positions === __bbp_prev_traj` to the `stable` check at line 1571.
- At the bottom of the `$effect.pre` body where `__bbp_prev_*` are updated: add `__bbp_prev_traj = trajectory_frame_positions`.
- Add `let trajectory_active = $derived(trajectory_frame_positions != null)` near line 470.
- Inside `$effect.pre` body, add the trajectory branch BEFORE the `stable` check:
  ```ts
  if (trajectory_active && trajectory_frame_positions) {
    if (import.meta.env?.DEV) __probe_bbp_meaningful++  // increment for W7 8.2
    bond_pairs = build_trajectory_bond_pairs(
      bond_state.bond_connectivity,
      trajectory_frame_positions,
      realtime_position_overrides,
      atom_manager,
    )
    __bbp_prev_traj = trajectory_frame_positions
    return
  }
  ```

**Note on `bbp_meaningful` semantics:** W1 design distinguishes `bbp_fires` (every effect entry) from `bbp_meaningful` (slow-path entry). The trajectory branch IS meaningful work but is NOT the slow path. For Phase 3's success criterion, `bbp_meaningful` should drop to 0 — meaning the trajectory branch returns BEFORE the `bbp_meaningful++` at the slow path. Choose ONE: either re-purpose `bbp_meaningful` to count "any meaningful work" (then increment in trajectory branch, but the Phase 4 success criterion changes) OR keep `bbp_meaningful` as "slow-path entry only" and add a separate `bbp_traj_fires` counter for Phase 3 verification. **Recommendation:** keep `bbp_meaningful` semantics unchanged (slow-path only). Phase 3 success is `bbp_meaningful = 0` (slow path never reached).

**Verification:**
```bash
pnpm check 2>&1 | grep -c "error"   # no increase
pnpm exec playwright test tests/playwright/structure-trajectory.test.ts \
  --grep "1\\.3|7\\.5|8\\.2|6\\.3"
# 1.3 (bonds ≥ 2 on F0 and F9) MUST pass — catches bond-freeze regression
# 7.5 (bonds visible in F5 screenshot) MUST match baseline
# 8.2 (bbp_meaningful = 0 during 3s playback) MUST pass
```

**Manual smoke test:**
1. Play trajectory. Visually verify bonds animate (stretch/contract between O and H atoms).
2. `window.__catgo_probe.snapshot()`: `bbp_meaningful = 0`, `bbp_fires ≈ 17`.
3. Navigate to frame 9. Bonds must be drawn at the displaced positions (H1 at x≈1.06).

**Rollback rehearsal:**
- `git revert <C3>`: trajectory branch removed from `build_bond_pairs $effect.pre`. `__bbp_prev_traj` declaration and `stable` check entry removed. `build_trajectory_bond_pairs` signature reverts. Bond rendering returns to old `build_bond_pairs` path (still working because Phase 4 hasn't landed).
- **Shippable:** YES.
- **W7 after revert:** GREEN.

**Lockout state:**
- Do not modify: `StructureScene.svelte:1595-1600` (`__bbp_prev_*` other than `__bbp_prev_traj`) — Phase 6 deletes them.

---

### Phase 4 + Phase 5 — Stop current_structure per-frame write + pause-and-edit handler (MANDATORY SINGLE COMMIT)

**Effort:** 3-4 hours (commit C4)

**Why merged:** Between Phase 4 and Phase 5, `current_structure` is frozen at topology-load (frame 0). A user who pauses at frame N and drags commits positions to frame-0 positions — silent stale bug. W7 Test 2.3 fails in that window.

#### Phase 4 — Gate `current_structure` write behind `topology_initialized`

**Files changed:** `src/lib/trajectory/Trajectory.svelte:448-468` (the frame-advance `$effect`).

```ts
// Add after line 444:
let topology_initialized = $state(false)
$effect(() => { trajectory; topology_initialized = false })  // reset on new traj

// Replace $effect at 448-468 with:
$effect(() => {
  const frame = current_frame
  if (!frame?.structure) {
    current_structure = undefined
    trajectory_frame_positions = null
    trajectory_frame_forces = null
    topology_initialized = false
    return
  }
  if (!topology_initialized) {
    current_structure = frame.structure  // first-frame topology init
    topology_initialized = true
  }
  if (position_cache) {
    trajectory_frame_positions = position_cache[current_step_idx] ?? null
    trajectory_frame_forces = force_cache?.[current_step_idx] ?? null
  } else {
    // Indexed/streaming trajectories: no cache, full structure writes per frame.
    current_structure = frame.structure
    trajectory_frame_positions = null
    trajectory_frame_forces = null
  }
})
```

**Knock-on bug fixes** (per `plans/phase4-current-structure-investigation.md` § Risks):
- `Trajectory.svelte:236` (`push_back_current_frame`): change `current_structure` → `current_frame?.structure`.
- `Trajectory.svelte:285` (`can_push_back` derived): change `!!current_structure` → `!!current_frame?.structure`.

**Critical observation about position_cache async build:** The position_cache is built asynchronously via `setTimeout` chunks. On the very first frame after load, `trajectory_frame_positions` may be null even though `current_structure` was just written. Architecture P's "fast path" only engages from frame 2 onward. The first render of every trajectory always uses the full Structure.svelte pipeline — this is a documented limitation, not a bug. ≤2ms/frame applies to frames 2+, not frame 1.

#### Phase 5 — T5 pause writeback (W2 Option 1) + W5 resume-disable

**Files changed:**

`src/lib/structure/Structure.svelte`:
- Add T5 writeback `$effect` after line 1114:
  ```ts
  let __prev_trajectory_active_for_writeback = false
  $effect(() => {
    const active = trajectory_active
    if (__prev_trajectory_active_for_writeback && !active) {
      // T5 writeback: trajectory just stopped. Write current GPU positions
      // back into structure so subsequent edits start from current frame.
      const mgr = scene_atom_manager
      if (!mgr || !structure) {
        __prev_trajectory_active_for_writeback = false
        return
      }
      // W2 Option 1: full reassignment. Propagates through $bindable to
      // current_structure in Trajectory.svelte (verified at the call site).
      const new_sites = structure.sites.map((site, i) => {
        const slot = mgr.find_slot_by_site_id(i)
        if (slot < 0) return site  // supercell-extra: leave at topology pos
        return {
          ...site,
          xyz: [mgr.get_x(slot), mgr.get_y(slot), mgr.get_z(slot)] as [number, number, number],
        }
      })
      structure = { ...structure, sites: new_sites }
    }
    __prev_trajectory_active_for_writeback = active
  })
  ```

`src/lib/trajectory/Trajectory.svelte` (W5 resume-disable per `plans/W5-resume-disable-design.md`):
- Line ~197: `let resume_disabled = $state(false)`
- After trajectory `$effect` block (~line 289): `$effect(() => { trajectory; resume_disabled = false })`
- `handle_atoms_deleted` (~line 1235), first line: `if (!is_playing) resume_disabled = true`
- `handle_atom_added` (~line 1227), first line: `if (!is_playing) resume_disabled = true`
- `handle_atom_replaced` (~line 1253), first line: `if (!is_playing) resume_disabled = true`
- Play button (~line 1357):
  ```svelte
  disabled={total_frames <= 1 || resume_disabled}
  title={resume_disabled
    ? `Structure was edited — reload trajectory to resume`
    : is_playing ? `Pause playback` : `Play trajectory`}
  ```

**Order of edits within C4:**
1. Add `topology_initialized` state + reset `$effect` to Trajectory.svelte.
2. Replace frame-advance `$effect`.
3. Fix `push_back_current_frame` (line 236).
4. Fix `can_push_back` derived (line 285).
5. Add T5 writeback `$effect` to Structure.svelte.
6. Add W5 resume-disable state + reset effect to Trajectory.svelte.
7. Add `if (!is_playing) resume_disabled = true` to three handlers.
8. Update play button `disabled` and `title` attributes.
9. `pnpm check`.
10. Manual smoke tests below.

**Verification:**
```bash
pnpm check 2>&1 | grep -c "error"  # no increase

pnpm exec playwright test tests/playwright/structure-trajectory.test.ts \
  --grep "2\\.3|2\\.4|4\\.3|4\\.4|6\\.4|6\\.5|5\\.3|8\\.1"
# 2.3 (drag-commit uses paused-frame position) MUST pass
# 4.3, 4.4 (T5 writeback verified) MUST pass
# 5.3 (cascade silence delta=0) MUST pass — PRIMARY ACCEPTANCE
# 6.4 (topology edit disables resume) MUST pass
# 6.5 (drag does NOT disable resume) MUST pass
# 8.1 (atom_data_fires delta=0) MUST pass
```

**Critical W1 acceptance check (HARD GATE):**
```js
window.__catgo_probe.reset()
// play 5 seconds
const s = window.__catgo_probe.snapshot()
console.assert(s.atom_data_fires === 0, 'cascade not silent')
console.assert(s.bbp_fires === 0, 'bbp not silent')
console.assert(s.bbp_meaningful === 0)
console.assert(s.apb_fires === 0, 'apb not silent')
console.assert(s.acb_fires === 0, 'acb not silent')
console.assert(s.nhsi_fires === 0, 'nhsi not silent')
// x2_fires and x2_traj_fast_path_fires expected to be ~15 (Phase 5.5 gates them)
```

**Manual smoke test:**
1. Load trajectory. Play.
2. Verify W1 hard gate above: 11 of 13 counters at 0; only `x2_fires` and `x2_traj_fast_path_fires` non-zero.
3. **Pause-and-edit test:** Pause at frame 5 (H1 at x≈1.01). Drag H1 by +0.2 Å. Commit (pointerup). DevTools: `window.__catgo_probe.get_atom_x(0)` should return ≈1.21, NOT ≈0.96. If it returns 0.96, T5 writeback is broken.
4. **Resume-disable test:** Pause. Right-click an atom → Replace element. Verify play button is disabled. Verify tooltip says "Structure was edited — reload trajectory to resume."
5. **Drag-then-resume test:** Pause. Drag an atom (don't replace element). Click play. Verify play button is NOT disabled.

**Rollback rehearsal:**
- `git revert <C4>`: BOTH Phase 4 changes (Trajectory.svelte topology_initialized, knock-on bug fixes) AND Phase 5 changes (T5 writeback in Structure.svelte, W5 wire-up in Trajectory.svelte) revert atomically. Behavior returns to Phase 3 state. Trajectory plays via the cascade. No drag-commit stale-position bug because the cascade is restored.
- **Shippable:** YES.
- **W7 after revert:** GREEN at Phase 3 baseline.

**Lockout state:**
- Do not modify: `StructureScene.svelte:2320` (X2 `$effect` entry) — Phase 5.5 modifies it.

---

### Phase 5.5 — X2 shadow sync gate on trajectory_active

**Effort:** 1 hour (commit C5). HARD PRECONDITION for Phase 6.

**Deliverable:** X2 `$effect` exits immediately when trajectory is active, eliminating the ~1-2ms/frame no-op loop and enabling Phase 6's safe deletion of the `trajectory_only` branch.

**Files changed:** `src/lib/structure/StructureScene.svelte:2320`

Add as the FIRST statement inside the `$effect` body:
```ts
$effect(() => {
  // Phase 5.5 gate: trajectory positions are written by Structure.svelte's
  // position-write loop (Phase 2). X2 has no work during playback. Without
  // this gate, Phase 6's deletion of the trajectory_only branch causes X2
  // to fall through to the 15-30ms slow-path diff.
  // When trajectory_frame_positions becomes null (playback stops), X2 fires
  // once and runs the full sync — correct: one topology recompute on stop.
  if (trajectory_frame_positions != null) return
  if (import.meta.env?.DEV) __probe_x2_fires++
  // ... rest of effect body
```

Note: `__probe_x2_fires++` moves AFTER the gate so it counts only fires that proceed.

**Verification:**
```bash
pnpm check 2>&1 | grep -c "error"  # no increase

# HARD GATE for Phase 6:
pnpm exec playwright test tests/playwright/structure-trajectory.test.ts \
  --grep "8\\.3"
# Test 8.3 (x2_slow_path_count delta = 0 during 3s playback) MUST pass
```

**Manual smoke test:**
1. Play trajectory.
2. `window.__catgo_probe.reset()`. Wait 5s. `window.__catgo_probe.snapshot()`.
3. Verify `x2_fires = 0` (gate prevents counter from being reached).
4. Verify all other critical counters still 0: `atom_data_fires`, `bbp_fires`, `apb_fires`, `acb_fires`, `nhsi_fires`.
5. Stop playback. Verify X2 fires once for topology recompute (counter increments by 1).
6. Stop playback, swap structure (load different file), verify bonds update — confirms X2 still runs when needed.

**Rollback rehearsal:**
- `git revert <C5>`: 1-LOC removal. X2 fires per frame again, takes the `trajectory_only` no-op loop (still present in Phase 6 hasn't landed). ~1-2ms/frame regression but no correctness issue.
- **Shippable:** YES.
- **W7 after revert:** GREEN (8.3 may fail with stricter Phase 5.5 calibration but earlier baseline variant is fine).

**Lockout state:**
- This phase is the gate for C6. Do not start C6 until Test 8.3 has been green for at least one complete W7 test session.

---

### Phase 6 — Delete all 5 patch categories

**Effort:** 1-1.5 hours (commit C6)

**Pre-condition (HARD):** W1 probe SILENT (counters that should be 0 actually 0) for at least one complete uninterrupted W7 test session. Test 8.3 green. Any non-zero counter during the session blocks Phase 6.

**Deliverable:** All 5 patch categories from commit `29420f91` deleted. Net LOC negative vs baseline.

#### Files changed and exact deletions:

`src/lib/structure/bond-computation-controller.svelte.ts`:
- Delete `freeze_connectivity_on_position_change: boolean = false` parameter (line 69) and its JSDoc.
- Delete lines 100–117: the `if (freeze_connectivity_on_position_change && !strategy_changed...)` block and `|TRAJ` sentinel.
- Delete lines 123–130: `[probe] bond-recompute trigger` console.log.
- Remove the parameter from all callers (search `StructureScene.svelte`).

`src/lib/structure/StructureScene.svelte`:
- Delete lines 1595–1602 (`__bbp_prev_conn`, `__bbp_prev_lbs`, `__bbp_prev_struct`, `__bbp_prev_overrides`, `__bbp_prev_drag`, `__bbp_prev_sel`, `__bbp_prev_overrides_size`, `__bbp_skips`). **KEEP `__bbp_prev_traj`** (added in Phase 3).
- Simplify the `stable` check at lines 1615–1633 to retain only the `__bbp_prev_traj` guard. Drag/topology/selection fires should do full rebuilds since they're intentional and infrequent.
- Delete lines 1855–1875: all `__atom_data_cache_*` variables and `__atom_data_fast_count`.
- Delete lines 1897–1936: trajectory fast-path block inside `atom_data $derived.by()`.
- Delete `__x2_prev_traj` declaration and `traj_changed` variable (lines 2307–2308 and 2360–2361).
- Remove `traj_changed` from the `anything_changed` computation at lines 2370–2373.
- Delete the `trajectory_only` branch: lines 2397–2423 (the `if (trajectory_only)` block AND the `const trajectory_only =` computation above it).
- Delete the `positions_only` branch: lines 2430–2454.
- Delete all `console.log('[probe]...')` lines in the X2 effect body (lines ~2378, ~2420, ~2451).

**KEEP (NOT deleted):**
- W1 probe counters at `StructureScene.svelte:1581-1593` — regression detector, not a patch.
- W1 probe surface `$effect` at end of script — regression detector.
- `build_trajectory_bond_pairs` function — Phase 3 wired it as live code.
- `prewarm_bond_worker()` in `bond-worker-api.ts` — Phase 7 uses it.
- `__bbp_prev_traj` (Phase 3 addition) — load-bearing for trajectory bond fast-path.

`src/lib/structure/viewer-controller.svelte.ts`:
- Delete the `[probe]` console.log in `property_colors $effect`.

**Verification:**
```bash
pnpm check 2>&1 | grep -c "error"  # no increase

pnpm exec playwright test tests/playwright/structure-trajectory.test.ts
# All 40 tests pass. Zero --update-snapshots needed.

git diff --stat 29420f91 HEAD | tail -1
# Net negative LOC

# CPU profiler verification: ≤2ms/frame during 878-atom trajectory playback
# Use browser Performance tab.
```

**Manual smoke test:**
1. `pnpm build` then `grep -r '__catgo_probe\|__probe_atom_data' dist/` — must return nothing (probe tree-shaken).
2. Play trajectory. W1 probe shows all counters at 0.
3. Compare per-frame JS cost in DevTools Performance tab against baseline (from `29420f91`): expect ≤2ms vs ~18ms.

**Rollback rehearsal:**
- `git revert <C6>`: re-introduces ~150 LOC. Behavior returns to Phase 5.5 state (which is W7-green and shippable). Mechanically clean — no manual re-introduction needed.
- **Shippable:** YES.
- **W7 after revert:** GREEN at Phase 5.5 baseline.

**Lockout state:**
- After C6 lands, do not modify any `__bbp_prev_*` or `__atom_data_cache_*` references — they're deleted; any stray reference will cause a TypeScript error.

---

### Phase 7 — Worker bond prewarm

**Effort:** 30 minutes (commit C7)

**Deliverable:** `prewarm_bond_worker()` called at Structure.svelte mount.

**Files changed:** `src/lib/structure/Structure.svelte`

Add to the existing `untrack(() => { ... })` block at line ~1574 (which currently prewarms via I1 commit `01191257`):
```ts
// Already present from commit 01191257 (I1):
// untrack(() => { prewarm_bond_worker() })
```

Note: I1 already shipped this. Phase 7 may be a no-op if I1's prewarm covers Architecture P's needs. **Verify** that I1's call site is still correct after Phases 1-6 land; if the `untrack` block was inadvertently removed during Phase 1's atom_manager lift, restore it.

**Verification:**
```bash
pnpm exec playwright test tests/playwright/structure-trajectory.test.ts \
  --grep "4\\.1|4\\.2|7\\.6"
# 4.1 (one bond re-detect on stop): pass
# 4.2 (bond pairs non-empty during stop): pass
# 7.6 (stop-transition screenshot): pass
```

**Manual smoke test:**
1. Fresh tab. Load trajectory. Play 2 seconds. Stop.
2. Visually verify no perceptible bond flash during stop transition.

**Rollback rehearsal:**
- `git revert <C7>`: prewarm call removed. First post-trajectory bond compute may use sync JS fallback (~150ms) instead of worker (~5ms). UX regression, not crash.
- **Shippable:** YES.

---

## Phase boundary safety table

| After commit | Reverted | Codebase state | Shippable? | Atoms visible? | Dev server starts? | W7 status |
|---|---|---|---|---|---|---|
| Phase 0 | (already shipped) | W1 probe in StructureScene | YES | YES | YES | 8/41 GREEN |
| C1 (Phase 1) | C1 | atom_manager local; buffers read structure.sites | YES | YES | YES | GREEN to baseline |
| C2 (Phase 2) | C2 | Position loop removed | YES | YES | YES | GREEN to C1 |
| C3 (Phase 3) | C3 | Bond fast-path removed; old build_bond_pairs path active | YES | YES | YES | GREEN to C2 |
| C4 (Phase 4+5) | C4 | Cascade restored (Phase 4 reverted); writeback removed (Phase 5 reverted) — atomic via single commit | YES | YES | YES | GREEN to C3 |
| C5 (Phase 5.5) | C5 | X2 fires per frame again, no-op loop active (~2ms/frame regression) | YES | YES | YES | 8.3 may fail with strict variant |
| C6 (Phase 6) | C6 | All 5 patch categories restored via clean revert (~150 LOC re-added) | YES | YES | YES | GREEN to C5 |
| C7 (Phase 7) | C7 | prewarm removed; first edit slower | YES | YES | YES | 4.2/7.6 may fail |

---

## Phase 6 deletion list (concrete)

| File | Lines | What |
|---|---|---|
| `bond-computation-controller.svelte.ts` | 64–69 | `freeze_connectivity_on_position_change` parameter + JSDoc |
| `bond-computation-controller.svelte.ts` | 100–117 | `\|TRAJ` trajectory fast-path block |
| `bond-computation-controller.svelte.ts` | 123–130 | `[probe]` debug log |
| `StructureScene.svelte` | 1595–1602 | `__bbp_prev_*` (except `__bbp_prev_traj`) |
| `StructureScene.svelte` | 1615–1633 | `stable` check (simplify to keep only `__bbp_prev_traj`) |
| `StructureScene.svelte` | 1855–1875 | `__atom_data_cache_*` and `__atom_data_fast_count` |
| `StructureScene.svelte` | 1897–1936 | trajectory fast-path block in `atom_data $derived.by()` |
| `StructureScene.svelte` | 2307–2308 | `__x2_prev_traj` declaration |
| `StructureScene.svelte` | 2360–2361 | `traj_changed` variable |
| `StructureScene.svelte` | 2370–2373 | `traj_changed` in `anything_changed` |
| `StructureScene.svelte` | 2397–2423 | entire `if (trajectory_only)` block + `const trajectory_only =` |
| `StructureScene.svelte` | 2430–2454 | entire `if (positions_only)` block + `const positions_only =` |
| `StructureScene.svelte` | various | All `console.log('[probe]...')` in X2 effect body |
| `viewer-controller.svelte.ts` | various | `[probe]` debug log |

---

## W7 test authoring schedule

Tests authored in dependency order. Agent-executable.

**Milestone 1 (DONE — commit `60eab61b`):** test page + Cat 1 (5 tests) + Cat 7 partial (3 tests).

**Milestone 2 (3h — pre-Phase-1):** Cat 8 baseline tests using existing W1 probe.
- Test 8.1 (atom_data fire count, dual-assertion).
- Test 8.2 (bbp not per-frame, cross-validated with 1.3).
- Test 8.3 (X2 slow path never taken — Phase 5.5 hard gate).
- Test 8.4 (per-frame JS cost with performance marks).

**Milestone 3 (3h — pre-Phase-2):** Cat 2 + Cat 3 + Cat 5 + Cat 6 partial.
- Tests 2.1, 2.5 (pause click + context menu, non-skipped variants).
- Tests 2.3, 2.4 (with `.skip('requires C4')`).
- Tests 3.1-3.5 (during-playback interactions).
- Tests 4.1, 4.2 (with `.skip('requires C7')`).
- Tests 4.3, 4.4 (with `.skip('requires C4')`).
- Tests 5.1, 5.3, 5.4 (memory + cascade silence).
- Test 6.1 (supercell no crash).

**Milestone 4 (2h — pre-Phase-4+5):** Cat 6 complete.
- Test 6.3 (h-bond during playback).
- Tests 6.4, 6.5 (with `.skip('requires C4')`).
- `FIXTURE_192A_20F` inline generation in test page.

**Milestone 5 (3h — pre-Phase-6 + Phase-7):** final tests.
- Test 5.2 (GPU buffer growth, with `.skip('requires C6')`).
- Test 7.6 (with `.skip('requires C7')`).
- Tests 7.3, 7.4 (timing-sensitive Cat 7 — defer to last).

---

## Hardening recommendations

1. **Git tag every phase boundary.** `git tag v3-traj-phase-1 <hash>` etc. Makes `git revert <tag>` unambiguous during incident response.

2. **W7 must be GREEN before each phase.** The per-phase gate matrix is meaningless without authored tests. Milestone 2 (Cat 8 baseline) is the highest-priority pre-Phase-1 work — Test 8.3 is the Phase 5.5/6 gate.

3. **W1 probe counters retained through Phase 6.** They are regression detectors, not patches. Future contributors who add a per-frame consumer of `structure` will be caught by the probe surface in DEV.

4. **Phase 6 hard gate enforcement.** "W1 silent across one complete uninterrupted W7 test session" — if the session is interrupted by system restart (probe state lost), do not enter Phase 6 until a fresh uninterrupted session passes.

5. **Plan v3 commits before any implementation.** This document should be in git history (committed as a doc) before C1 lands, so `git blame` can reference the design intent.

6. **Vibration mutex testing.** Add a Milestone 3 test: "enable vibration during trajectory playback, confirm no crash and trajectory positions take precedence."

7. **Production monitoring follow-up.** W1 is DEV-only. After v3 ships, consider a lightweight production counter that logs every N minutes if `atom_data $derived` is firing during playback.

---

## Verification confidence assessment

| Phase | Confidence (1-10) | Gap |
|---|---|---|
| Phase 0 (already shipped) | 10 | — |
| C1 (Phase 1) | 8 | The `$bindable` double-allocation at mount is detectable only via memory profiling; no automated test |
| C2 (Phase 2) | 9 | H3 timing hazard requires Performance tab inspection; no automated test |
| C3 (Phase 3) | 7 | `__bbp_prev_traj` correctness only fails at C4; latency between cause and symptom |
| C4 (Phase 4+5) | 9 | W1 silence is binary; T5 writeback verified by tests 4.3+4.4 |
| C5 (Phase 5.5) | 9 | Test 8.3 is a perfect binary gate |
| C6 (Phase 6) | 8 | Patch deletion that breaks non-trajectory functionality (e.g., a memo also used during drag) — Cat 2/3 should catch most |
| C7 (Phase 7) | 7 | Test 4.2 (flash duration) is timing-sensitive in Playwright |

---

## Open questions for v4

1. **`bbp_meaningful` semantic split.** W1 design distinguishes `bbp_fires` from `bbp_meaningful`. Phase 3's trajectory branch is "meaningful work" but not slow path. v4 may split into `bbp_fires`, `bbp_traj_fires`, `bbp_slow_meaningful` for cleaner phase verification.

2. **`$effect` ordering for T5 writeback.** Svelte 5 doesn't guarantee ordering between effects in different components. Tests 4.3 and 4.4 will empirically catch this; if they fail flakily, formalize ordering via a custom dispatcher.

3. **`build_trajectory_bond_pairs` supercell index space.** Phase 3 uses `atom_manager.find_slot_by_site_id(site_idx)` for out-of-range bond endpoints. For supercell structures, `site_idx` from `bond_connectivity` is a displayed-structure index. Verify behavior when manager site_ids are supercell-expanded indices.

4. **Pencil fragment add false-negative for `resume_disabled`.** `pencil-mode.svelte.ts:443` bulk-adds via `try_add` but does NOT call `deps.get_on_atom_added()` (only single-atom path at line 383 does). Fragment add is a false negative for W5. Separate follow-up commit required (independent of plan v3 phase ordering).

5. **Charge label position fix (W3 Q1).** Under Architecture P, `charge_label_entries` freezes label positions at trajectory start when `visible_charge_labels.size > 0`. Targeted fix: extend `compute_charge_label_entries` to accept `trajectory_frame_positions` and `atom_manager.site_ids_buffer`. Tracked as I5. Not blocking v3.

6. **Production performance regression detection.** W1 probe is DEV-only. After v3 ships, monitor for regressions where someone inadvertently reintroduces a per-frame reactive consumer of `structure`. Consider a lightweight always-on counter.

---

## Total effort summary

- Implementation: 14-19 hours (Phases 1-7)
- W7 test authoring (Milestones 2-5): 11-14 hours
- Manual smoke testing (per phase): 2-3 hours
- Multi-agent reviews per phase commit (recommended): 4-6 hours
- **Total: 31-42 hours** across 7-10 sessions

This is the deliberate price of doing it right, per the resumption checklist's anti-pattern warning: "don't push through reviewer findings under time pressure."
