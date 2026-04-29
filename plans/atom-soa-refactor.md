# Atom SoA Refactor — Architectural Plan

Branch: `atom-soa-refactor`
Started: 2026-04-24

## Goal

Zero-lag atom operations in the Structure viewer, same quality bar we already
hit for bonds. "Zero-lag" here means: deleting / adding / replacing an atom in
an 878-atom structure costs **≤50ms from keystroke to paint**, with no visible
FPS hitch on the rest of the page.

Today that number is ~200–400ms for a trajectory case and ~300ms for a
single-frame export. After this refactor: uniformly ≤50ms.

## Why a refactor and not a patch

Earlier in this session we landed Phase A–D of a trajectory "pending-ops
queue" that moved cross-frame atom-edit cost to O(1). That shipped a large
win (~2s → ~300ms for multi-frame deletes). What remains is the Structure-
side cost — uniform across single-frame and multi-frame, because it's no
longer cross-frame overhead, it's the render pipeline itself.

That render pipeline is architecturally wrong for high-performance editing:

- **Atoms live in `structure.sites`** (pymatgen-shaped Site objects). Svelte 5
  deep-proxies every property access. Profiling shows ~86% of delete-time
  CPU spent in `Proxy` trap handlers.
- **`atom_data` $derived** has ~10 reactive deps and iterates every site on
  *any* input change. A color change triggers the same work as a position
  change.
- **`AtomImpostors`** writes all 5 per-instance GPU attributes on every
  buffer rebuild. No per-attribute dirty tracking.
- **Bond re-detection** runs from scratch (~120ms for 878 atoms, sync JS)
  on every atom mutation. The previous bond graph is discarded even though
  a delete only removes a known set of bonds.

A "quick fix" (incremental bond-update, or shrinking `atom_data` deps) would
paper over the symptoms without fixing the shape of the problem. The proper
answer is the same pattern we already used for bonds — SoA store, sparse GPU
updates, command-pattern edits — applied to atoms.

## Reference: bond refactor (already shipped)

The existing bond architecture is the template:

- `src/lib/structure/bonding/bond-manager.svelte.ts` — SoA store with
  typed-array buffers for pairs, kinds, colors, opacity. Single `version`
  counter; per-slot dirty tracking via `dirty_slots`.
- `src/lib/structure/bonding/bond-instanced-renderer.ts` — reads manager,
  uploads only changed instance slots via `addUpdateRange`.
- `src/lib/structure/bonding/BondManagerInstances.svelte` — Threlte
  component wrapping the renderer; single `threlte.invalidate()` after each
  sync.
- `src/lib/structure/bonding/bond-undo-stack.ts` — command-pattern undo
  stack; records only the delta per edit.
- `src/lib/structure/StructureScene.svelte:~1848` — diff-based shadow sync
  that mirrors `filtered_bond_pairs` into the manager.

The whole bond system produces O(edit) cost at the mutation site and O(edit)
GPU upload. We want the same for atoms.

## Target architecture (atoms)

```
┌──────────────────────────────────────────────────────────────────────┐
│  structure.sites (canonical pymatgen-shaped data — unchanged)         │
│                                                                        │
│        │ (shadow sync via $effect)                                    │
│        ▼                                                               │
│  ┌──────────────────────────────────┐                                  │
│  │ AtomManager (SoA)                │                                  │
│  │  positions_buf : Float32Array    │                                  │
│  │  radii_buf     : Float32Array    │                                  │
│  │  elements_buf  : Uint8Array      │ ← element-index, dense           │
│  │  colors_buf    : Float32Array (lazy) │                              │
│  │  opacities_buf : Float32Array (lazy) │                              │
│  │  saturations_buf: Float32Array (lazy)│                              │
│  │  count, version, dirty_*: per-attr slot sets │                      │
│  └──────────────────────────────────┘                                  │
│        │                                                               │
│        ├─ AtomInstancedRenderer ─▶ GPU (per-attr addUpdateRange)      │
│        │                                                               │
│        └─ BondManager ◀─ incremental atom→bond coupling                │
│                          (delete atom ⇒ drop touching bonds +         │
│                           reindex; skip full re-detection)             │
└──────────────────────────────────────────────────────────────────────┘
```

Key invariants:
- `structure.sites` remains canonical. Export, serialization, workflow
  integration, and anything outside the render pipeline keep reading it.
- `AtomManager` is the render-oriented shadow. Renderer and edit paths
  read it. Never read `structure.sites` in hot code.
- Edits are **commands** applied to both managers atomically. A delete
  produces `AtomCommand.Delete(indices)`; both AtomManager and BondManager
  apply it incrementally.
- Undo is command-pattern: each command records its inverse in a stack,
  analogous to `BondUndoStack`.

## Phases

Each phase is independently shippable and testable. Flag-gated rollout
(`USE_NEW_ATOM_SYSTEM`) mirrors the bond pattern — existing code paths
stay alive as a fallback until Phase X7.

### X1 — Scaffold AtomManager SoA store

Files (new):
- `src/lib/structure/atoms/atom-manager.svelte.ts`
- `src/lib/structure/atoms/atom-command-stack.ts`
- `src/lib/structure/atoms/feature-flag.ts` (exports
  `USE_NEW_ATOM_SYSTEM = false`)

Deliverables:
- `AtomManager` class with public API:
  - `count`, `version`, `capacity`
  - `positions_buffer`, `radii_buffer`, `elements_buffer`,
    `colors_buffer`, `opacities_buffer`, `saturations_buffer`
  - `dirty_positions`, `dirty_colors`, `dirty_radii`, etc.
    (per-attribute slot sets)
  - `ensure_capacity(n)`, `shrink_to_fit(slack)`
  - `add_atoms(positions, radii, elements, ...)` bulk
  - `remove_atoms(slots)` with swap-and-pop
  - `set_position(slot, xyz)`, `set_color(slot, rgb)`,
    `set_opacity(slot, o)`, etc.
  - `begin_colors_batch()` / `commit_colors_batch()` — same
    batch pattern as BondManager
  - `clear_dirty()`, `clear()`
- `AtomCommandStack` skeleton (public API parallels `BondUndoStack`)
- Unit tests parallel to `bond-manager.test.ts`

Zero runtime behavior change. Nothing imports these yet.

### X2 — Shadow sync from `structure.sites`

Files modified:
- `src/lib/structure/StructureScene.svelte` — new `$effect` that mirrors
  `structure.sites` + override maps into `AtomManager`. Diff-based:
  compare against manager's current state, issue `add_atoms` /
  `remove_atoms` / `set_*` only for the delta. Single source of truth
  remains `structure.sites`; manager is a lazy mirror.

Zero behavior change from consumer perspective. Manager now reflects
reality; still nothing reads it in hot paths.

### X3 — `AtomInstancedRenderer` (flag-gated)

Files (new):
- `src/lib/structure/atoms/atom-instanced-renderer.ts` — per-attribute
  sparse GPU uploads. Separate `InstancedBufferAttribute` per visual
  attr; each with its own `addUpdateRange` driven by
  `manager.dirty_positions`, `dirty_colors`, etc. `needsUpdate` and
  `threlte.invalidate()` handled per sync, same contract as
  `BondInstancedRenderer`.
- `src/lib/structure/atoms/AtomManagerInstances.svelte` — Threlte
  component wrapping the renderer. Two meshes: opaque + transparent,
  same layering as current AtomImpostors.

Files modified:
- `src/lib/structure/StructureScene.svelte` — `{#if USE_NEW_ATOM_SYSTEM}`
  branch uses `AtomManagerInstances`; else falls through to the
  existing `AtomImpostors` path. Both paths coexist.

Flag stays false. No user-visible change. Behind the flag, the new
renderer is usable.

**First measurable win:** turning the flag on in dev shows atom_data
re-derivation is no longer the bottleneck (the derive still runs but
doesn't drive renders). Per-attribute dirty tracking eliminates the
"color change rewrites positions too" waste.

### X4 — Incremental bond update on atom delete

Files modified:
- `src/lib/structure/bonding/bond-manager.svelte.ts` — new method
  `apply_atom_delete(deleted_indices: number[])`:
  - Iterate live slots; remove any bond where either endpoint is in
    `deleted_indices`
  - For surviving bonds, shift `site_idx_1` / `site_idx_2` down by
    `count_of_deleted_less_than(idx)`
  - Mark affected slots dirty; bump version
- `src/lib/structure/bond-computation-controller.svelte.ts` — if current
  edit is a pure delete, call `apply_atom_delete` on the manager
  directly instead of running full `compute_bonds_sync`. Fall back to
  full re-detection for any non-delete mutation or if fingerprints
  disagree.

This is where the 120ms → ~2ms win lands.

### X5 — Direct-to-manager atom deletes

Files modified:
- `src/lib/structure/controllers/pencil-mode.svelte.ts` or the atom
  context-menu actions — atom delete path calls
  `AtomManager.remove_atoms(slots)` **directly** (behind flag), then
  triggers the incremental bond update from X4. Skips the shadow-sync
  round trip entirely for common case.
- `structure.sites` is still updated (canonical), but the manager
  already has fresh state; shadow-sync becomes a no-op diff.

After this phase, deletes are O(edit) end-to-end: no full `atom_data`
rebuild, no full AtomImpostors rewrite, no full bond re-detection.

### X6 — Add / replace / move through manager

Same pattern as X5 for the other three mutation types:
- `add_atoms` (pencil atom add, adsorbate placement, etc.)
- `replace_atom` (right-click "replace with element")
- `move_atom` (drag / keyboard arrow move / trajectory-drag
  displacement)

Each mutation type gets its own incremental bond-update helper on
`BondManager` where applicable (add: may create new bonds, needs
partial detection; replace: preserves topology; move: may create or
destroy bonds depending on distance change).

### X7 — `AtomCommandStack` undo + flag flip + cleanup

- Wire `AtomCommandStack` into the undo system. Each edit records its
  inverse command; Ctrl+Z pops and applies.
- Flip `USE_NEW_ATOM_SYSTEM = true` as default.
- Remove the old `AtomImpostors` full-update path and the old
  `atom_data` $derived if no longer needed.
- Grep for residual direct `structure.sites` reads in the render path
  and migrate them.
- Remove the feature flag.

## Coexistence with the pending-ops work

The trajectory pending-ops refactor landed Phases A–D; E–I deferred.
Those live on this same branch under the `pending-ops queue` section
of the code. They coexist cleanly with the atom refactor:

- Pending-ops operates at the trajectory layer (cross-frame).
- AtomManager operates at the structure layer (per-frame).
- The two stack: a delete triggers an atom-kind command (handled by
  AtomCommandStack on the current frame) and enqueues a pending-op
  for other trajectory frames.

Deferred pending-ops phases (E–I) become tasks to resume after the
atom refactor ships:
- E: undo queue integration for delete kind
- F: route `handle_atom_added` through pending queue
- G: route `handle_atom_replaced` through pending queue
- H: route `handle_atoms_manipulated` through pending queue
- I: remove old `_chunked_cross_frame_edit` machinery
- J: final benchmark + commit + push

## Testing cadence

After each phase, a specific test validates the phase independently:

| Phase | Manual test |
|-------|-------------|
| X1 | Unit tests pass; no runtime change visible |
| X2 | Unit tests pass; no runtime change visible. Verify manager state mirrors sites by logging `count` + sampling positions |
| X3 | Flip flag locally; render identical to old path. Any visual discrepancy = bug |
| X4 | Delete atom on 878-structure; bond compute logs `~2ms` instead of `~120ms`; bonds visually correct |
| X5 | Delete atom Tfinal ≤50ms; no frame drops |
| X6 | Add / replace / move all ≤50ms; no frame drops during drag |
| X7 | Flag permanent; regression tests; fallback path removed |

## Success metrics

- Delete 1 atom from 878-atom structure: **Tfinal ≤ 50ms** (currently ~300ms)
- Delete 1 atom from 878-atom, 583-frame trajectory: **Tfinal ≤ 80ms**
  (combined X-phase + already-landed pending-ops Phase D)
- 1000-atom interactive drag: **60fps sustained**
- No regression on trajectory playback
- Memory overhead: AtomManager buffers bounded at
  `num_atoms × (3+1+1+3+1+1) × 4 bytes` = ~40 bytes per atom, negligible

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Shadow sync drifts from `structure.sites` during complex edits (PBC image atoms, supercell transforms) | Medium | Comprehensive test matrix covering those transforms; X2 includes a "dev-mode parity assertion" comparing manager state to sites |
| Per-attribute dirty tracking has reactivity holes | Low | Bond refactor proved the pattern; replicate test coverage |
| X4 incremental bond update misses edge cases (PBC wrap-around, periodic bonds) | Medium | Incremental path is opt-in; full re-detection stays as fallback for any fingerprint mismatch |
| Command-pattern undo interacts badly with trajectory pending-ops | Low-Medium | Pending-ops E phase designed specifically to consume the atom command stack |
| Refactor scope creeps | Medium | Strict phase gates. If X3's flag-on reveals a rendering issue we didn't plan for, fix that before X4, not in parallel |

## Non-goals

- Not changing `structure.sites` as canonical data. No API break for
  external consumers.
- Not rewriting bond detection algorithms. We're making *delete* faster,
  not making fresh bond detection faster. Fresh detection stays as the
  fallback for non-incremental mutations.
- Not touching the trajectory framework beyond the pending-ops already
  landed (A–D) and the deferred phases (E–I).
- Not optimizing for the sub-100-atom case. Below that threshold
  everything is already fast; we're tuning for 500–10k atom structures.

## Commit strategy

- One commit per phase X1–X7.
- Plan document (this file) committed first.
- Pending-ops Phase A–D + trajectory-parser fix + atom A1/A2 foundation
  committed as a baseline on this branch with honest commit messages
  linking back to the plan.
- No force-pushes once the branch is shared. Every phase rebased/merged
  cleanly onto origin atomically.

## Timeline estimate

This is a real refactor, not a sprint. Rough estimate:

- X1 (scaffold + unit tests): 1 day
- X2 (shadow sync): 1 day
- X3 (renderer + flag): 1–2 days
- X4 (incremental bonds): 1 day
- X5 (delete through manager): 1 day
- X6 (add/replace/move): 2 days
- X7 (undo + flag flip + cleanup): 1–2 days

**Total: ~1.5–2 weeks focused work**, assuming no major surprises.

## Deferred work (tracked separately)

After this refactor ships:

- Pending-ops Phases E–J on trajectory framework (tasks #17–#22)
- AtomManager `$state.raw` consideration for very large structures
  (>10k atoms) — only if needed
- Property-color Worker offload for Wyckoff/charge/custom modes (element
  mode already cheap; coordination already Worker-based)
- Drag manipulation through pending-ops queue with 60fps coalescing
