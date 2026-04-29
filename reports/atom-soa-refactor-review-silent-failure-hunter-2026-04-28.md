# Silent-Failure Audit — `split-files...atom-soa-refactor`

**Reviewer:** `pr-review-toolkit:silent-failure-hunter`
**Date:** 2026-04-28
**Scope:** T5 pause writeback (commit `931e79c7`) + supercell trajectory warning (`442a5a7a`).

**Files audited:**
- `src/lib/trajectory/Trajectory.svelte`
- `src/lib/structure/Structure.svelte`

---

## Finding 1 — CRITICAL — Silent state desync: scrubbing while paused leaves `current_structure` stale

**Location:** `src/lib/trajectory/Trajectory.svelte:561-591` (current_frame `$effect`) in concert with `pause_playback` at `:729-773`.

The new T5 design has two distinct invariants depending on which event fires:

1. On pause: `pause_playback` writes the frame's `trajectory_frame_positions` back into `current_structure.sites` (lines 749–765).
2. On frame change after `topology_initialized = true`: the current_frame `$effect` updates *only* `trajectory_frame_positions` (line 581) and deliberately **skips** writing `current_structure` (the comment at lines 571–576 explains why — to avoid the displayed_structure cascade).

These invariants compose incorrectly when a user **pauses, then scrubs to a different frame while still paused**:

| Step | `current_step_idx` | `trajectory_frame_positions` | `current_structure.sites[i].xyz` | GPU positions |
|------|---|---|---|---|
| Play frame 0..5 | rolling | frame N | frame 0 (load) | frame N (live) |
| Pause on frame 5 | 5 | frame 5 | **frame 5** (writeback fires) | frame 5 |
| User drags slider to frame 10 | 10 | frame 10 | **STILL frame 5** | frame 10 |

The user sees frame 10 on screen, but any click/drag/delete/replace operating against `structure.sites` reads the **frame-5 xyz positions**. The Phase 5 T5 contract is violated for every frame the user navigates to after the initial pause.

**Why this is silent.** No log, no warning, no UI affordance. Atom impostors render at frame-10 positions (Structure-side position-write loop writes Float32 positions directly to the atom manager / GPU), but click handlers read `structure.sites[i].xyz` for hit-test planes and drag commit targets. Visible atom and click target are at different positions.

**Confirmation from the diff itself.** Commit `442a5a7a` documents this exact behavior in its message: *"even with substantial drag distances (150 px), the dragged positions don't reliably propagate to structure.sites in trajectory mode"* — the test author dropped the assertion rather than investigate. That dropped assertion is the smoking gun for this desync.

**Recommendation.**
- **(a)** Move the writeback to the current_frame `$effect`, gated on `!is_playing`. Whenever the displayed frame changes while paused, sync `current_structure.sites`. Costs one extra structure spread per scrub-step (only while paused).
- **(b)** Defer the writeback until the moment the user actually edits — hook it into the start of `handle_atom_added` / `handle_atoms_deleted` / `handle_atom_replaced` / `handle_atoms_manipulated` and into the drag-start path in `interaction.svelte.ts`.

(a) is safer and matches the original T5 plan's intent.

---

## Finding 2 — HIGH — Pause writeback always allocates new structure ref (no equality short-circuit)

**Location:** `src/lib/trajectory/Trajectory.svelte:749-765`.

The writeback unconditionally rebuilds `current_structure.sites` even when (a) pause fires twice in a row, or (b) the user pauses on frame 0 where positions match the load-time structure.

`trajectory_frame_positions` entries are `Math.fround`'d (per the position-cache builder); `structure.sites[i].xyz` is double precision. So the rebuilt xyz triplet is *always* bit-different from the original on frame 0, even though the visual position is identical. Each pause creates a new `structure` object reference, propagating through `bind:structure` to Structure.svelte and re-firing:

- `unique_elements` `$derived`
- `property_colors` `$effect` (potentially expensive — coordination coloring spawns a worker)
- `cell_transformed_structure` `$derived` → supercell `$effect` → PBC `$effect` → displayed_structure
- StructureScene's atom_data, bond pipeline, etc.

The auto-align effect is correctly gated by `trajectory_active`, but the rest of the cascade is not. On a paused trajectory with a non-trivial supercell (e.g. `2x2x2`), this triggers a full WASM supercell rebuild on every pause — silently.

**Recommendation.** Cheap guard — short-circuit the writeback when the new xyz array is bit-equivalent to the current one (Math.fround the existing site xyz once and compare). Also add an early `if (!is_playing) return` at the top of `pause_playback` to defend against external double-fire.

---

## Finding 3 — MEDIUM — Atom-count mismatch silently truncates with no log

**Location:** `src/lib/trajectory/Trajectory.svelte:752-754`.

```ts
const max_i = Math.min(sites.length, Math.floor(positions.length / 3))
const new_sites = sites.map((site, i) => {
  if (i >= max_i) return site   // ← partial pass
  ...
})
```

If `positions.length / 3 !== sites.length`, the writeback silently writes only the prefix. The tail of `sites` keeps prior xyz; the prefix gets the trajectory-frame xyz — a Frankenstein structure with **zero log output**.

The analogous condition in `Structure.svelte:1170-1174` (Phase 2 position-write loop) **does** emit a dev warning; `pause_playback` does not.

**Recommendation.** Mirror the Structure.svelte supercell warning:

```ts
if (import.meta.env?.DEV && max_i < sites.length) {
  console.warn(
    `[trajectory] pause writeback: ${sites.length} sites but cache covers only ${max_i}. ` +
    `Tail atoms keep prior positions (likely supercell-extra; verify if not).`
  )
}
```

---

## Finding 4 — MEDIUM — `on_pause` callback may fire before `$bindable` flush

**Location:** `src/lib/trajectory/Trajectory.svelte:766-772`.

The writeback assigns `current_structure` immediately before `on_pause` fires. Svelte 5 reactivity flushes the new `$bindable` value to the parent on the next microtask, not synchronously. If `on_pause` is wired to a parent handler that reads the bound `current_structure` (e.g., for export or analysis), it will read the **pre-writeback** value. Today's `on_pause` payload is `{ trajectory, step_idx, frame_count }` so consumers must recompute — but the contract is fragile.

**Recommendation.** Either pass the post-writeback structure into the `on_pause` payload explicitly (matching the `frame: current_frame` pattern used by `on_end`/`on_step_change`), or document on the callback type that `current_structure` is not guaranteed to be flushed yet.

---

## Finding 5 — LOW — Dead-effect comment stub is structurally detached from its only remaining consumer

**Location:** `src/lib/structure/Structure.svelte:1123-1131`.

The dead-effect stub correctly explains *why* the writeback was moved out, but it sits ~60 lines above the only remaining functional consumer of `trajectory_active` (the auto-align gate at line 1187).

**Verified:** no orphaned consumers of `trajectory_active` — the two `StructureScene.svelte` mentions are also comments. The move is structurally clean; the only risk is a future developer reading the auto-align effect without scrolling up far enough to see the rationale.

**Recommendation.** Add a one-line breadcrumb at line 1187 referencing the comment block. Cosmetic.

---

## Finding 6 — Confirmed OK — Supercell warning gating

**Location:** `src/lib/trajectory/Trajectory.svelte:1465-1484`.

All four edge cases verified:

- **Async load false-fire:** Warning is inside `{:else if trajectory}`. During async parsing, `loading = true` so the `{#if loading}` branch wins; `trajectory` only becomes truthy after `parse_trajectory_async` resolves. **No false-fire risk.**
- **Mid-playback supercell change:** `supercell_scaling` is `$bindable` and reactive — toggling during playback shows/hides correctly.
- **Trajectory unload while supercell non-trivial:** The whole `{:else if trajectory}` branch unmounts; warning vanishes correctly.
- **Supercell + pause-writeback interaction:** `current_structure` at pause time is the **base cell** (supercell expansion happens inside Structure.svelte's reactive chain, downstream of `bind:structure`). So `sites.length === positions.length / 3` — Finding 3's truncation case should not fire in normal supercell usage. Worth a comment documenting the assumption.

---

## Out-of-scope but worth flagging

- **`Trajectory.svelte:419-422` `load_frame_on_demand`** swallows errors with `console.error` (no Sentry / `logError`). Pre-existing.
- **`Trajectory.svelte:312` `push_back_current_frame`** uses `console.warn` rather than `logError`. Pre-existing.

---

## Summary table

| # | Severity | Issue |
|---|---|---|
| 1 | CRITICAL | Scrubbing-while-paused silently desyncs `current_structure` from displayed frame; click/edit operates on wrong xyz |
| 2 | HIGH | Pause writeback always allocates new structure ref (no equality short-circuit), forcing full reactive cascade — costly with supercell + property colors |
| 3 | MEDIUM | Atom-count mismatch between position cache and `sites` is silently truncated with no log |
| 4 | MEDIUM | `on_pause` fires before `$bindable` flush; future consumers reading `current_structure` see stale value |
| 5 | LOW | Dead-effect stub comment is structurally detached from its only remaining `trajectory_active` consumer (cosmetic) |
| 6 | OK | Supercell warning gating verified correct under all four edge cases |

**Top priority:** Finding 1. The pause writeback as shipped is a one-shot that silently goes stale on the very next user interaction (frame scrub, in-pause replay-from-frame-0, plot click). The `442a5a7a` commit message already records the symptom; the test was weakened rather than the underlying desync fixed.
