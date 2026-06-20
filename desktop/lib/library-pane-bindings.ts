import type { StructureTabState } from '../pane-utils'
import { findLeafById, leaves, structurePane, type LeafNode } from '../pane-tree'

/** Find the structure leaves displaying one exact library-entry instance. */
export function leaves_for_library_entry(ts: StructureTabState, entry_id: string): LeafNode[] {
  return leaves(ts.root).filter((leaf) => structurePane(leaf)?.library_entry_id === entry_id)
}

export type LibraryRemovalRequest =
  | { kind: 'missing' | 'unbound' | 'ambiguous' }
  | { kind: 'close'; leaf_id: string }

/** Prepare an exact-instance sidebar removal without closing anything yet. */
export function prepare_library_entry_removal(
  ts: StructureTabState,
  entry_id: string,
): LibraryRemovalRequest {
  if (!ts.library.some((entry) => entry.id === entry_id)) return { kind: 'missing' }
  const bound = leaves_for_library_entry(ts, entry_id)
  if (bound.length > 1) return { kind: 'ambiguous' }
  if (bound.length === 0) {
    ts.library = ts.library.filter((entry) => entry.id !== entry_id)
    sync_active_library_entry(ts)
    return { kind: 'unbound' }
  }
  const leaf_id = bound[0].id
  ts.pending_library_removal = { entry_id, leaf_id }
  ts.active_leaf_id = leaf_id
  ts.active_library_id = entry_id
  return { kind: 'close', leaf_id }
}

/** Derive the sidebar selection from the pane that is actually active. */
export function sync_active_library_entry(ts: StructureTabState): string | null {
  const leaf = findLeafById(ts.root, ts.active_leaf_id)
  const entry_id = leaf ? structurePane(leaf)?.library_entry_id ?? null : null
  ts.active_library_id = entry_id && ts.library.some((entry) => entry.id === entry_id)
    ? entry_id
    : null
  return ts.active_library_id
}

/** Cancel a pending sidebar removal only when it belongs to this close banner. */
export function cancel_pending_library_removal(ts: StructureTabState, leaf_id: string): void {
  if (ts.pending_library_removal?.leaf_id === leaf_id) {
    ts.pending_library_removal = null
  }
}

/**
 * Commit a sidebar removal after the bound pane has really closed.
 * Re-validating both IDs prevents an asynchronous save from deleting a
 * different entry after the pane was reused.
 */
export function commit_pending_library_removal(
  ts: StructureTabState,
  leaf_id: string,
  closed_entry_id: string | null,
): boolean {
  const pending = ts.pending_library_removal
  if (!pending || pending.leaf_id !== leaf_id) return false
  ts.pending_library_removal = null
  if (!closed_entry_id || pending.entry_id !== closed_entry_id) return false
  ts.library = ts.library.filter((entry) => entry.id !== pending.entry_id)
  return true
}
