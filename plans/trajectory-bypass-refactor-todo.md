# Trajectory Bypass Refactor — Open Work Breakdown

**Status:** RESOLVED (2026-04-26) — all W-items completed; plan v3 drafted and shipped at `plans/trajectory-bypass-refactor-v3.md`. This document is preserved as the historical record of what blocked v2 and how each blocker was unblocked. Implementation lives in commits C1-C6 (`492446a0` → `f01762b5`) on branch `atom-soa-refactor`.

**Resumption checklist final state:**
- [x] W1 — detector designed AND validated against patched code (commits `f7b844e0` → `54705594`)
- [x] W2 — `$bindable` writeback Option 1 selected & verified at all 3 call sites (`plans/W2-bindable-writeback-verification.md`)
- [x] W3 — `displayed_structure` consumer audit complete (`plans/W3-displayed-structure-audit.md`)
- [x] W4 — `atom_manager` lift Option A decided (`plans/W4-atom-manager-lift-audit.md`)
- [x] W5 — Trajectory.svelte resume-disable wire-up implemented (commit `d4249cbd`)
- [x] W6 — architecture decision (P over S) made + reviewed by 3 independent agents
- [x] W7 — 16 tests green on baseline (Milestones 1+2+3 + 8.4); 16 deferred to Milestone 5 (`plans/W7-milestone-5-todo.md`)
- [x] W8 — already shipped at `bd0da10f`
- [x] Phase 4 `current_structure` open question resolved (`plans/phase4-current-structure-investigation.md`)
- [x] Plan v3 written + multi-reviewer pass + implementation through C1-C6
- [x] Implementation has explicit rollback path per phase (verified by live revert during smoke testing)
**Branch baseline:** `atom-soa-refactor` at commit `29420f91` (the patch baseline)
**Companion:** `plans/trajectory-bypass-refactor.md` — the paused plan, with full reviewer findings preserved
**Estimated total effort:** 1-2 weeks across multiple sessions, with sleep between major design iterations

---

## Why this exists

Two thorough review rounds on the bypass refactor plan surfaced 8 high/medium-severity unresolved issues that we couldn't responsibly address in a single working session. Rather than push through under time pressure (which is exactly how the patch stack on commit `29420f91` happened in the first place), this document captures the work needed to do the refactor properly.

The current shipped state (commit `29420f91`) gets trajectory playback to ~13-25 ms/frame (40-75fps) via a stack of memos and fast-paths. That's shippable. The proper refactor would get it to ≤2ms/frame and remove the patches — but it needs more deliberate planning than we have time for in any single session.

---

## Outstanding plan issues to resolve before resuming

The reviewer findings are preserved in `plans/trajectory-bypass-refactor.md` § "Outstanding v2 issues". Each requires design work before T-series implementation can begin. Numbered to match the v2 plan review.

### W1. Design a working dev-mode regression detector for cascades (replaces v2 T2.3)

**The problem (v2 issue #1):** The proposed `console.warn` inside `atom_data $derived` doesn't work because `$derived` is a pure function with no access to the `trajectory_active` parent state, and after a refactor would lift atom_manager out, StructureScene may not receive `trajectory_frame_positions` as a prop at all.

**Required design output:** A pattern that empirically proves the architectural fix eliminates per-frame `atom_data` / `build_bond_pairs` / `X2 shadow sync` re-fires. Without this, deleting the patches in T6 is reckless — we'd be assuming the fix works without verification.

**Candidate approaches to evaluate:**
- A separate `$effect` in the parent (Structure.svelte) that watches `atom_data` identity changes (via a version counter we add) AND `trajectory_active`. Warns when the former changes while the latter is true.
- Instrument each suspected effect with a per-frame fire counter exposed on `globalThis` (DEV only). After 5 sec of trajectory playback, dump counts; assert near-zero.
- Use a Performance API marker pattern: `performance.mark` per fire, dev-mode aggregator that flags suspicious frequencies.

**Acceptance:** the chosen mechanism actually compiles, runs, and would catch a regression where one of the over-fires returned. Validate the mechanism on the CURRENT patched code (where over-fires happen) — it should fire warnings TODAY before the refactor, then go silent after the refactor.

### W2. Resolve `$bindable` deep-mutation propagation for T5 writeback

**The problem (v2 issue #2):** T5 plans to write trajectory's last-frame positions back into `structure.sites[i].xyz` on pause, but `structure` is a `$bindable` prop and deep mutations don't reliably propagate through Svelte 5's binding mechanism unless the parent declared `structure` as `$state`.

**Required design output:** A documented contract for how trajectory positions land back in the live structure state on pause. Options:
- Reassign `structure = { ...structure, sites: structure.sites.map(...) }` (creates new ref, guarantees re-derive but breaks if parent doesn't bind to `$state`)
- Use `supercell_structure` as the writeback target (only works if trajectory is always loaded on a non-supercell base — must be documented restriction)
- Use a callback prop (`on_trajectory_pause(positions: Float32Array) => void`) that the parent owns
- Add a dedicated "live trajectory positions" state in Structure.svelte that downstream consumers can read with override precedence

**Acceptance:** document the chosen pattern, verify against the CURRENT Structure.svelte parent contract (search call sites of `<Structure bind:structure>`), confirm propagation works in a small test.

### W3. Audit `displayed_structure` sibling consumers

**The problem (v2 issue #3):** The snapshot mechanism only freezes what StructureScene sees. Sibling components (charge labels, bond edit cleanup, possibly export pane, AtomLegend) read `displayed_structure` and would still see live updates per trajectory frame.

**Required design output:** A complete inventory of every `displayed_structure` consumer with classification:
- Per-frame consumers that NEED live updates (none expected, but verify)
- Per-frame consumers that should be snapshot-frozen too
- Consumers that don't fire reactively on every change (safe)

**How to do it:** grep for `displayed_structure` in `src/lib/**`, trace each read to the consuming `$effect` / `$derived` / template binding. Document costs.

**Acceptance:** a table of all consumers, costs, and required handling. The refactor design must explicitly address every "needs snapshot" case OR pivot to an architecture (W6 below) that doesn't have asymmetric state.

### W4. Audit X5/X6 incremental hooks for atom_manager lift impact

**The problem (v2 issue #5):** `try_delete`, `try_add`, `try_replace`, `try_move` in StructureScene's `AtomFastOps` interface (`atom-manager.svelte.ts:80-121`) capture StructureScene-local state (`atom_radius`, `element_radius_overrides`, `colors.element`, `property_colors`). Lifting `atom_manager` to Structure.svelte either moves these hooks too (breaking GPU/scene separation per the design comment at `atom-manager.svelte.ts:47-50`) or leaves the lift incomplete.

**Required design output:** a clear pattern for where atom_manager lives, where the hooks live, and how they communicate. Options:
- Hooks stay in StructureScene as closures; Structure.svelte gets the manager via a `bind:atom_manager` ref and passes it to Trajectory.svelte
- Hooks move to Structure.svelte; scene-local state (radii, colors, plugins) gets exposed via a controller object
- Hybrid: thin hooks in Structure.svelte that delegate to scene-internal logic via callback props

**Acceptance:** design doc with chosen pattern, traceability to every existing hook caller, no implicit reliance on scene-local state from outside the scene.

### W5. Trajectory.svelte resume-disable wire-up (v2 issue #6)

**The problem:** T5's "disable resume after structure-altering edits" has no implementation path. Trajectory.svelte's `is_playing` is local; no prop or callback exists for the parent to disable resume.

**Required design output:** a small additive change to Trajectory.svelte's prop interface — either a `resume_disabled: boolean` prop OR an `on_structure_altered` callback the parent can use to clear the trajectory.

**Acceptance:** prop signature documented, UX surface (toast? button-disabled state? error message?) decided.

### W6. Design decision: snapshot vs position-only-write pivot

**The problem:** v2's snapshot approach has correctness gaps (issue #3 — sibling cascades). A position-only-write pivot (Trajectory.svelte stops writing `current_structure` per frame, only writes `trajectory_frame_positions`) is structurally simpler but un-vetted.

**Required design output:** a decision document comparing the two architectures with concrete data:
- Which downstream consumers break / are simplified by each approach
- How each handles supercell, PBC images, vibration mode, drag-during-playback
- How each interacts with X5/X6 incremental hooks (W4)
- How each handles the pause-and-edit case (W2)
- Implementation effort estimate for each

**Acceptance:** explicit recommendation backed by analysis. No more "we'll figure it out in implementation."

### W7. Build a real regression test suite for trajectory + interactions

**The problem:** No automated test covers trajectory playback + drag, trajectory + edit, trajectory + supercell toggle, trajectory + hide-element, trajectory exit, trajectory resume, etc. Without these, the refactor's "no behavioral change" claim is unverifiable.

**Required design output:** a Playwright test suite covering:
- Trajectory plays smoothly (frames advance, atoms move, bonds follow)
- Pause mid-playback → atom click selects correct atom
- Pause → drag atom → resume → drag override clears
- Pause → element swap → resume disabled with UI message (per W5)
- During playback: hide element, change coloring mode, toggle PBC images
- Stop playback → bonds re-detect once → no flash
- Repeated start/stop (memory leak check)
- Trajectory + supercell 2×1×1 (verify positions correct, no garbage)

**Acceptance:** tests run green on commit `29420f91` (the current patched state). Refactor must keep them green.

### W8. align_on_load trajectory gate (v2 issue #8)

**The problem:** `align_on_load` $effect in Structure.svelte (~line 1116-1143) fires per trajectory frame. The `structure_aligned_id` guard prevents the actual write only if the aligned marker is set on the new frame — which it generally isn't for trajectory frames. This is a real per-frame cost in the patched state today, not just a refactor concern.

**Required design output:** add a `trajectory_active` gate to the `align_on_load` $effect so it skips during playback. This is a small, independent fix — could ship before the broader refactor.

**Acceptance:** verify by adding a probe and confirming the effect doesn't fire per trajectory frame.

---

## Independent improvements (could ship before W1-W8)

These don't depend on the bypass refactor and would benefit users immediately:

### I1. Worker bond detection prewarm

Same as v2 plan T7. ~30 min.
- Add `prewarm_bond_worker()` call in Structure.svelte's onMount.
- First user-triggered structure edit goes through the Worker (~5ms) instead of fallback (~150ms sync JS).
- Files: `src/lib/structure/Structure.svelte`, uses already-exported `prewarm_bond_worker()` from `bond-worker-api.ts`.

### I2. align_on_load trajectory gate (W8 above, ship standalone)

~15 min. Independently valuable.

### I3. Three.Color CSS-var warning

Per-frame console warning `THREE.Color: Unknown color model var(--struct-active-highlight-color, #2563eb)`. Three.js doesn't parse CSS var references. We're passing a CSS var string where a hex is expected.

Find the call site (likely `SelectionHighlights.svelte` or `StructureScene.svelte`'s active highlight props) and resolve the CSS var to a hex value before passing to Three.js. Use `getComputedStyle(element).getPropertyValue('--struct-active-highlight-color')` or define a default fallback.

### I4. Remove the AtomLegend per-frame console.log

The inline IIFE at `Structure.svelte` (`elements={(() => { ... console.log(...) ... return e })()}`) prints once per render. It's dev debug print left in. Remove or gate behind a debug flag.

---

## Resumption checklist

Before reopening `trajectory-bypass-refactor.md` for implementation:

- [ ] W1 — dev-mode regression detector designed AND validated against current patched code
- [ ] W2 — `$bindable` writeback contract documented and verified
- [ ] W3 — `displayed_structure` sibling consumer audit complete
- [ ] W4 — atom_manager lift + X5/X6 hook pattern decided
- [ ] W5 — Trajectory.svelte resume-disable wire-up designed
- [ ] W6 — snapshot vs position-only-write decision made with backing analysis
- [ ] W7 — regression test suite green on commit `29420f91`
- [ ] W8 — align_on_load gate (could be I2, ship standalone)
- [ ] Plan v3 written incorporating W1-W6 outcomes
- [ ] Plan v3 reviewed by 2+ reviewers across separate sessions
- [ ] Implementation plan has an explicit rollback path per phase

---

## What NOT to do

- Don't add more memos or fast-paths to the patches in `29420f91`. They work, leave them.
- Don't rewrite Trajectory.svelte without W6 decision.
- Don't lift `atom_manager` to Structure.svelte without W4 design.
- Don't delete the patches without W1's regression detector proving the cascades are gone.
- Don't ship the refactor in a single PR — phase it with feature flags so each step is independently revertable.
- Don't push through reviewer findings under time pressure. The patch stack is the warning sign of what happens then.

---

## Why "1-2 weeks" not "an afternoon"

This refactor touches:
- Three reactive trees (Trajectory.svelte → Structure.svelte → StructureScene.svelte) with non-trivial cascades
- Two GPU buffer managers (atom_manager, bond_manager) with their own reactivity
- The X5/X6 incremental hook contract that Structure.svelte and StructureScene share
- Sibling components reading `displayed_structure` outside the main render path
- Svelte 5 `$effect.pre` micro-flush behavior we still don't fully understand

The 8 reviewer findings span all of these. Resolving them takes time and conversation. The architectural decision in W6 alone is worth a separate document with a longer review window.

The patches we have now are good enough to ship. The refactor will be better — when there's time to do it right.
