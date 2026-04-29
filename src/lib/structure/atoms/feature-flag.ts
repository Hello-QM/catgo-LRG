/**
 * Feature flag for the AtomManager integration.
 *
 * X7 flipped this to `true` as default — the atom render pipeline now
 * flows through the SoA `AtomManager` + `AtomInstancedRenderer` stack.
 *
 * The legacy `AtomImpostors` full-buffer-rebuild path is kept behind the
 * `{:else}` branch in `StructureScene.svelte` as an emergency escape hatch
 * for the next few weeks — flip to `false` to fall back if a regression
 * ships. Plan X7's "delete legacy path + remove flag" step is a separate
 * follow-up commit once flag-on has soaked.
 *
 * Known regressions when flag is on (vs legacy path):
 *   - Partial-occupancy wedges: sites with multiple species per location
 *     render single-species only on the impostor mesh. The legacy
 *     partial-occupancy `{#each}` block in StructureScene still handles
 *     these, so wedges are visible regardless of this flag. But X2's
 *     shadow sync stores first-species only — wedge colors may be slightly
 *     off until closed as a follow-up.
 *   - AtomCommandStack is scaffolded (X1) but not yet wired to Ctrl+Z;
 *     undo still routes through the structure-snapshot path, which works
 *     correctly (restores structure → shadow sync repopulates the manager)
 *     but is slower than the forward delete. Wiring the command stack to
 *     the global undo is tracked as X7 follow-up.
 *
 * Not exposed in settings — toggle via source edit + rebuild for dev/debug.
 */
export const USE_NEW_ATOM_SYSTEM = true
