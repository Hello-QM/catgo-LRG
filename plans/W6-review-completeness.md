# W6 Review — Completeness Gaps (Reviewer 3)

**Reviewing:** `plans/W6-architecture-decision.md`
**Branch:** atom-soa-refactor @ bd0da10f
**Reviewer angle:** Find what's MISSING — concerns, edge cases, integration points the document doesn't address.

---

## Overall Completeness Score: 6/10

Justification: The document correctly decides between architectures, handles 8 stated per-architecture concerns, fully incorporates W3 and W4, and provides a phase plan with reversibility. However, it leaves 3 blocking implementation questions open and 5 medium-severity gaps unspecified for plan v3 drafting. A decision document for a 12-18h refactor that leaves 7 findings unresolved has enough gaps to require plan v3 to significantly extend W6 before implementation begins.

---

## HIGH — Must be addressed in plan v3 before implementation begins

### Finding 1 — Vibration-trajectory mutex unverified

W6 says "Out of scope, mutually exclusive in current UX." V2 plan T1.c explicitly listed this as needing audit. **The W6 document does NOT verify the claim.**

Code at `StructureScene.svelte:1610-1637`: vibration `$effect` reads `vibration_data` and writes `realtime_position_overrides` (`new Map()` per rAF tick). Under Architecture P's position-write loop:
- Trajectory loop checks `realtime_position_overrides?.has(sid)` for "drag wins" precedence
- If vibration is simultaneously active: vibration writes `realtime_position_overrides` → loop treats every atom as "drag-overridden" → trajectory positions never written → **atoms display vibration positions, not trajectory positions**

This is silent wrong behavior with no error. W1 doesn't catch it (W1 monitors `atom_data` and `build_bond_pairs`, not the override interaction).

**Plan v3 must:** Confirm UI gate exists with code evidence (not assertion), or add an explicit `trajectory_active && vibration_data?.playing` mutex.

---

### Finding 2 — W2 writeback contract not actually selected

W6 Phase 5 says: `structure = { ...structure, sites: new_sites }` per W2 contract.

W6 cites "W2 contract" but **W2's entire purpose is to DEFINE this contract.** W2 lists four options:
1. Full object reassignment
2. Write to `supercell_structure` as writeback target
3. Callback prop `on_trajectory_pause(positions)`
4. Dedicated "live trajectory positions" state

W6 appears to assume Option 1 without explicitly selecting it. W2's acceptance criterion requires verification: "verify against the CURRENT Structure.svelte parent contract (search call sites of `<Structure bind:structure>`), confirm propagation works in a small test."

`Structure.svelte:694` shows `structure = $bindable(undefined)`. The Svelte 5 `$bindable` propagation guarantee for full reassignment requires the parent to declare `let structure = $state(...)`. There are call sites in App.svelte and WorkflowEditor.svelte (trajectory context) — not all may follow this pattern.

**Plan v3 must:** Explicitly select W2 Option 1 and document verification at every `<Structure bind:structure>` call site.

---

### Finding 3 — Phase 4 `current_structure` removal scope unresolved (load-bearing)

W6 Open Question #2 asks: "Does Trajectory.svelte use `current_structure` for anything other than the per-frame position update?" — W6 defers this entirely.

The first-frame write `current_structure = frame.structure` at trajectory LOAD is what causes Structure.svelte to run the `cell_transformed_structure → supercell → PBC → displayed_structure` pipeline once at load to populate `displayed_structure` with the trajectory's base topology BEFORE playback starts.

If Phase 4 removes ALL `current_structure` writes, base topology may not be initialized correctly. If Phase 4 removes ONLY per-frame writes (keeping first-frame), the change is more complex than "remove the line."

W6 calls Phase 4 "1h (change is small; verification via W1 is the substance)" — this estimate assumes the change is simple, which is unverified.

**Plan v3 must:** Specify exactly which writes are "per-frame" vs "load-time" and what the Phase 4 conditional looks like.

---

## MEDIUM — Should be addressed in plan v3

### Finding 4 — W7 test suite required before Phase 0, not mentioned

The resumption checklist in `plans/trajectory-bypass-refactor-todo.md` requires: **"W7 — regression test suite green on commit `29420f91`"** BEFORE implementation begins.

W6 references "W7 green" as a gate in Phases 1, 2, 3, and 6 — but W7 does not exist yet. Each phase's "W7 green" gate is vacuously satisfied by an absent test suite. There are no existing W7 tests at the baseline commit that cover trajectory playback.

**Plan v3 must:** Specify W7 authoring as a pre-Phase-0 prerequisite. Each phase description must name the specific W7 test scenarios that must pass.

---

### Finding 5 — W5 detection mechanism unspecified

W6 Phase 5 says Structure.svelte sets `resume_disabled = true` "when a structure-altering edit occurs during pause" but doesn't specify:
- Which X5/X6 hook types trigger this (`try_add`, `try_delete`, `try_replace` should disable resume; `try_move` should NOT — drag-then-resume is a valid workflow)
- Where the detection code lives (in each hook, in `Structure.svelte:on_atoms_manipulated` callback, or a new $effect watching topology hash)

**Plan v3 must:** Specify which hook types trigger resume_disabled and where detection lives.

---

### Finding 6 — Charge label fix mechanism unspecified

W6 Architecture P section says: "extend `compute_charge_label_entries` to accept `trajectory_frame_positions` and `atom_manager.site_ids_buffer` as override inputs." Then Open Question #7 says: "Recommend: separate work item, not blocking Phase 3."

Concrete fix specified, then deferred. Doesn't say:
- Work item ID for tracking (I5? W9?)
- Whether fix lands before refactor ships
- User-facing behavior in interim (frozen labels with no message? warning overlay? labels hidden?)

A "frozen labels, no message" default is a silent regression from current behavior where labels at least track the trajectory-start position.

**Plan v3 should:** Either specify fallback UX (frozen labels + UI note) or commit fix to Phase 3.

---

### Finding 7 — Multi-instance `<Structure>` scenarios not analyzed

The codebase uses `<Structure>` in multiple places (main viewer, comparison view, workflow node previews via `CalcStructurePreview.svelte`/`StructurePreview.svelte`). Each instance creates its own `scene_atom_manager`.

W6 doesn't verify:
- Whether `prewarm_bond_worker()` (Phase 7) is idempotent under multiple concurrent `<Structure>` mounts
- Whether the W1 detector (fire counters) works correctly across multiple instances — instance B's interactive trajectory shouldn't trigger false positives in instance A's detector

W4 audit doesn't analyze multi-instance either.

**Plan v3 must verify:** `prewarm_bond_worker()` idempotency (already fixed in I1 — worker is global, so multi-instance is fine), and W1 instance scoping.

---

## LOW — Worth flagging but not blocking

### Finding 8 — WKWebView 60fps cap not acknowledged

CLAUDE.md user memory: "WKWebView capped at 60fps (WebKit Bug #294338)." On Tauri (primary deployment per CLAUDE.md), 60fps frame budget is 16.7ms.

Architecture P targeting ≤2ms JS leaves 14.7ms for GPU. Sound budget. But the 60fps cap means Tauri users won't see >60fps regardless of P's gains. Worth noting in plan v3 to set user expectations.

### Finding 9 — HMR resource leak (dev-mode concern)

After Phase 1, `let scene_atom_manager = $state<AtomManager>(new AtomManager())` is local to Structure.svelte. Svelte HMR re-executes the module, creating a fresh `AtomManager`. The Three.js scene's InstancedMesh GPU buffers may be orphaned if not fully torn down. Dev-mode only.

### Finding 10 — Production failure mode (no W1 in production)

W6 explicitly scopes W1 to DEV. After Phase 6 patch deletion, if a Svelte 5 update or platform-specific behavior causes `atom_data` to re-fire in production, there's no runtime indication. Per-frame cost silently climbs back to 13-25ms. Worth a lightweight always-on counter that logs every N minutes.

### Finding 11 — Memory growth not analyzed

V2 plan T1.g (buffer-size assumptions audit) was an open work item. W6 doesn't note whether T1.g was completed. Phase 2's position-write loop assumes `trajectory_frame_positions` is a reference swap to pre-allocated `position_cache` entries (no per-frame allocation), but this is unstated.

### Finding 12 — IOPane export race during pause

User workflow "pause → immediately export" may execute before the `$effect` detecting `trajectory_active → false` fires (Svelte 5 effects are async). Window between pause-click and T5 writeback completion is a frame or two. Unlikely to bite in practice, but a known limitation.

---

## What W6 Handles Correctly (do not change)

1. **Supercell LB1 guard analysis under P** — `min(mgr.count, traj.length / 3)` bound, the existing `StructureScene.svelte:2346` guard reasoning, and the UI-message recommendation are all sound.
2. **Phase sequencing logic (additive Phase 2, pivot Phase 4)** — Decision Log #4 correctly identifies that Phase 4 must follow Phase 2+3, that "Phase 2 additive" is the right framing, and that reversibility requires Phases 1-3 be independently revertable. Sequencing logic is correct (though specific phase boundaries have separate problems per Reviewer 2).

---

## Coverage of W-Items as Inputs to W6

| W-item | Coverage in W6 |
|---|---|
| W1 (regression detector) | Phase 0 specifies mechanism. Open Q3 defers exact implementation. Partially addressed. |
| W2 (writeback contract) | Phase 5 assumes Option 1 without selecting. **Partially addressed.** |
| W3 (displayed_structure audit) | Fully incorporated throughout. |
| W4 (atom_manager lift) | Phase 1 chooses Option A. Fully addressed. |
| W5 (resume-disable) | Phase 5 specifies prop + tooltip UX. Detection mechanism unspecified. **Partially addressed.** |
| W7 (test suite) | Referenced in every phase as a gate. **Pre-Phase-0 prerequisite NOT specified.** |
| W8 (align_on_load gate) | Decision Log #3 confirms already-fixed at `Structure.svelte:1119`. Closed. |

---

## Recommendations for Plan v3

**Must be in plan v3 before implementation begins:**
- Finding 1 (vibration mutex verification)
- Finding 2 (W2 Option 1 selection + verification)
- Finding 3 (Phase 4 current_structure removal scope)
- Finding 4 (W7 as pre-Phase-0 gate with named scenarios per phase)
- Finding 5 (W5 detection mechanism)

**Can be deferred to later iterations:**
- Finding 6 (charge label fix) — accept frozen labels as known limitation, separate work item
- Finding 8 (WKWebView cap) — one-sentence acknowledgment
- Finding 7 (multi-instance) — add note; I1 already provides idempotency
- Finding 9 (HMR leak) — dev-mode-only concern, document in CLAUDE.md
- Finding 10 (production monitoring) — future enhancement
- Finding 11 (memory growth) — confirm T1.g closure
- Finding 12 (IOPane race) — document edge case
