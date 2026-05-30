/**
 * Deep-clone helper for structure objects assigned into viewer panes.
 *
 * Why this exists: a `PaneState.structure` may be sourced from an object that is
 * ALSO referenced elsewhere — a module-level sample singleton, a tab's library
 * entry (`LibraryEntry.structure`), or a reused database-import payload. The 3D
 * viewer + WASM scene fast-ops (`try_move` / `try_add` / `try_replace`) mutate
 * `structure.sites[i]` IN PLACE for performance, and `move_atom` keeps shared
 * site-object references for unmoved atoms. So if two panes (or two tabs) alias
 * the same source object, an edit in one pane bleeds into the other — observed
 * as "structures cross between tabs / between panes".
 *
 * Fix: every pane must own an independent deep copy. Assign through this helper.
 */

import type { AnyStructure } from '$lib'

/**
 * Return a deep-independent copy of a structure. `null` / `undefined` pass
 * through unchanged so call sites can wrap assignments unconditionally.
 */
export function clone_structure<T extends AnyStructure | null | undefined>(s: T): T {
  if (s == null) return s
  try {
    return structuredClone(s)
  } catch {
    // Svelte $state proxies or exotic values can trip structuredClone; the
    // JSON round-trip is a safe fallback for the plain-data structure shape.
    return JSON.parse(JSON.stringify(s)) as T
  }
}
