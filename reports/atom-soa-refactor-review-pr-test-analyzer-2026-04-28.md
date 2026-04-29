# W7 Trajectory Test Suite — PR Test Analyzer Review

**Reviewer:** `pr-review-toolkit:pr-test-analyzer`
**Date:** 2026-04-28
**Branch:** `atom-soa-refactor` (vs `split-files`)
**Scope:** the 18 new W7 Playwright tests landed in milestone 5

## Executive summary

The suite is **largely real coverage** — most tests exercise the actual reactive graph end-to-end and would fail if the production paths regressed. But a handful of tests (notably **2.1**, **2.5**, **4.3**, **6.3**, parts of **6.4/6.5**) have weakened assertions or fixture geometry that could let realistic regressions slip through. The two specifically flagged tests (**2.3**, **2.4**) survive the simplification — both retain a meaningful contract — but the simplification of **2.3** does narrow what it catches.

The probe surface itself is mostly honest: `override_size`, `get_atom_x`/`get_atom_xyz`, `align_on_load_fires`, `atom_manager_capacity`, `get_camera_matrices`, `filtered_bond_pairs_count`, and `get_structure_site_x` are read straight off the production data structures. The two probes that warrant scrutiny are `is_playing` (sourced from a side-channel global, not the `is_playing` `$state`) and the `__catgo_traj_test.trigger_*` test handlers used by 6.4/6.5 (which call production handlers directly, bypassing the UI event flow).

## Verdicts (one line per test)

| ID | Verdict | Note |
|---|---|---|
| **2.1** click-to-select correct atom | **Pass-by-accident (likely)** | `atom_interaction_mesh` is built from `atom_data` which is silenced under Architecture P; on jump-to-frame-5 the mesh stays at frame-0 positions. H1 displacement at frame 5 is only 0.05Å vs ~0.32Å H radius, so a click at the projected frame-5 pixel still hits the frame-0 hitbox. Test would PASS even if the picker mesh stayed frozen at frame 0 — i.e., the exact bug `6a04ea4c` was meant to fix. |
| **2.3** drag override mid-drag | **Real coverage (narrow)** | Simplified assertion `max_override_during_drag >= 1` honestly verifies the Shift+Alt drag gesture reaches `apply_pending_drag` → `realtime_position_overrides.set`. Catches drag-activation breakage. Does NOT catch "drag distance silently zero". |
| **2.4** drag release clears override | **Real coverage** | `override_size` reads the live `realtime_position_overrides` Map. Drag commit path does `realtime_position_overrides = new Map()`. Honest probe of an honest invariant. |
| **2.5** right-click context menu identifies element | **Tautology / pass-by-accident** | The assertion `text.contains('Select all H')` is satisfied by the menu enumerating ALL unique elements — even if right-click landed on O instead of H1, the menu would still contain "Select all H". The W7 design called for `[data-testid="context-menu-atom-label"]` which doesn't appear to have shipped. |
| **3.1** hide H during playback | **Real coverage** | Asserts `filtered_bond_pairs_count: 2 → 0`, `atom_count` unchanged at 3. End-to-end. |
| **3.2** color-scheme change cascade-silent | **Real coverage (strongest in suite)** | Post-change `atom_data_fires <= 2` is a real cascade-silence assertion. DEV counter is incremented inside the actual `$derived.by()` body. |
| **3.3** PBC image toggle during playback | **Real coverage** | Asserts atom_count grows above 3 after toggle, bonds remain >= 2 throughout. Independent observations. |
| **4.3** atom GPU x at stop matches paused frame | **Pass-by-accident (weak)** | Asserts `gpu_x ≈ 0.96 + paused_idx*0.01` where `paused_idx` is read AFTER play+pause. Test mostly asserts the fixture-frame formula matches itself. Original W7 design used a fixed `FRAME_7_H1_X` target — much stricter. |
| **4.4** structure.sites reflects last frame after pause | **Real coverage** | Two semi-independent code paths (GPU SOA vs `$bindable` chain) cross-checked. Catches the original Phase 5 bug, the `$bindable` propagation, and the deep-mutation copy. |
| **5.2** atom_manager capacity stable | **Real coverage (narrowed scope)** | Honest probe. Scope narrowed from W7 design's "10 page reloads" to "within one session" — trades cross-load leak detection for in-session stability. |
| **5.4** structure swap clears stale entries | **Real coverage** | Non-trivial 3 → 4 atom delta forces real rebuild. |
| **6.1** supercell + trajectory no garbage positions | **Real coverage** | Reads two raw atom positions post-toggle, asserts finite + |v| < 100Å. Catches NaN/buffer-mismatch garbage. |
| **6.2** supercell warning UI displayed | **Real coverage (positive AND negative)** | `toHaveCount(0)` at 1x1x1 → `toBeVisible` after 2x1x1 → `toHaveCount(0)` again. **Verifies disappearance.** |
| **6.3** h-bond toggle no crash | **Smoke test (with tautological probe)** | The H–O distance in the fixture is 0.96Å, OUTSIDE the typical 1.5–3.5Å h-bond range, so `h_bond_pairs_count` is expected to be 0. The assertion `h_bonds >= 0` is tautological. Effectively a no-crash smoke test that doesn't exercise h-bond detection. |
| **6.4** topology edit disables resume | **Real coverage (with caveat)** | Calls `__catgo_traj_test.trigger_atoms_deleted()` directly, bypassing UI. Asserts (a) `resume_disabled = true`, (b) the play button's `disabled` binding tracks the flag. UI-level test would be stronger. |
| **6.5** drag-then-resume not disabled | **Real coverage** | Same architecture as 6.4. The contract is the ABSENCE of a `resume_disabled = true` mutation in `handle_atoms_manipulated`. |
| **6.6** align_on_load doesn't fire during playback | **Real coverage** | Counter is incremented INSIDE the alignment branch, AFTER the `trajectory_active` early-return. |
| **6.7** single-frame trajectory disables play | **Real coverage** | Direct DOM assertion gated on `total_frames <= 1`. |

## Specific answers to flagged questions

**2.3 — was the simplification meaningful?** The narrowed assertion (`override_size >= 1` mid-drag) IS still meaningful — it catches drag-activation breakage. But it does NOT catch "drag math silently produces zero displacement" — that path would still write `[same as start]` to the override map and pass. Real coverage but narrower than the original contract.

**2.4 — is `override_size` an honest probe?** Yes. Reads `realtime_position_overrides?.size ?? 0` from the live `$state` Map at `interaction.svelte.ts:245`. Drag-finalization at line 450 (`realtime_position_overrides = new Map()`) clears the same Map the probe reports. Honest probe of an honest invariant.

**6.2 — does it check the negative case?** Yes. Toggle-toggle-toggle pattern. Warning element only renders inside `{#if supercell_scaling !== '1x1x1'}` so it physically unmounts when supercell returns to identity.

**4.4 — does the new assertion prove the writeback works?** Yes, IF the test lands past frame 0 (the `differ from frame 0` sanity check enforces this). The two probes read genuinely independent code paths. Real coverage.

## Probe surface tautology audit

| Probe | Source | Verdict |
|---|---|---|
| `get_atom_x(slot)` / `get_atom_xyz` | `atom_manager.get_x(slot)` — raw SOA Float32Array | Honest |
| `get_structure_site_x(idx)` | `structure?.sites?.[idx]?.xyz?.[0]` — live prop | Honest |
| `atom_manager_capacity` | `atom_manager.capacity` — real grow-only counter | Honest |
| `align_on_load_fires` | DEV counter inside alignment branch, after `trajectory_active` guard | Honest |
| `override_size` | `realtime_position_overrides?.size` — live `$state` Map | Honest |
| `selected_site_id` | `selected_sites[selected_sites.length - 1]` — live `$bindable` | Honest probe; usefulness depends on click hitting the right atom (see 2.1) |
| `filtered_bond_pairs_count` | `filtered_bond_pairs.length` — live `$derived` | Honest |
| `is_playing` (probe getter) | `globalThis.__catgo_traj_is_playing` — side-channel global | **Yellow flag**: this is NOT the real `is_playing` `$state` in Trajectory.svelte. Not used in the 18 tests for assertion. |
| `atom_count` | `atom_manager.count` | Honest |
| `__catgo_traj_test.resume_disabled` | live `$state` | Honest probe; trigger_* methods bypass UI flow |

## Critical gaps the suite SHOULD cover but doesn't

1. **GPU picker stale-position regression (criticality 9)** — explicit motivation for 2.1/2.5. As written, both tests would pass even if `atom_interaction_mesh` were frozen at frame-0 positions, because the H2O fixture's 0.05Å per-frame displacement is sub-radius. **Fix:** add a fixture variant with per-frame displacement >= 2× atom radius, or click at frame-9.
2. **Drag-commit position correctness (criticality 8)** — the original 2.3 contract. Nothing in the 18-test suite verifies drag during paused trajectory advances `structure.sites` to a new x-coordinate.
3. **Cross-page-load capacity / interval / GPU-buffer leak (criticality 7)** — original W7 5.2 spec. Memory-leak regressions usually manifest across navigation/reload.
4. **4.3 needs a deterministic frame target (criticality 6)** — assert `paused_idx > 0` as a precondition.
5. **2.5 doesn't verify hit-test target (criticality 6)** — assert per-atom header text contains "H".
6. **6.3 doesn't actually verify h-bond detection (criticality 4)** — fixture geometry produces zero h-bonds. Either add a real h-bond fixture (O···O at ~2.7Å) or document explicitly as a no-crash smoke test.
7. **6.4/6.5 bypass UI event chain (criticality 5)** — at least one integration test that performs an actual context-menu delete would close this.
8. **No vibration-trajectory mutex test, W7 3.4 (criticality 7)** — silent wrong behavior per W7 Open Q3. Probes exist; authoring is unblocked.
9. **No charge-label non-crash during playback, W7 3.5 (criticality 4)** — milestone-5 doc explicitly defers as manual-smoke-simpler.

## Positive observations

- **3.2 is the strongest test in the suite.** Cascade-silence over a 2-second window with one legitimate trigger.
- **4.4 cleanly proves the writeback path** through two independent code paths plus a frame-0 sanity check.
- **6.6 hits the exact line that should not execute** — DEV counter inside the alignment branch after all early-returns.
- **5.4 uses non-trivial structure delta** (3 → 4 atoms) forcing real rebuild.
- **6.2 covers both visibility transitions.**
- **The probe surface is well-documented inline.**
