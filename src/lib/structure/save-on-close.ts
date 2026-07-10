// Close-guard decision helper: given whether a tab is modified, a confirm
// prompt, and a save action, decide whether the caller should proceed to close.
//
// Returns true  → caller may close the tab/pane.
// Returns false → caller must abort the close (cancel, or a failed save).
export async function guard_close(opts: {
  modified: boolean
  on_save: () => Promise<boolean>
  confirm: () => Promise<'save' | 'discard' | 'cancel'>
}): Promise<boolean> {
  if (!opts.modified) return true
  const choice = await opts.confirm()
  if (choice === 'cancel') return false
  if (choice === 'discard') return true
  // 'save': close only if the save actually succeeded; a failed save keeps the
  // tab open so the user does not lose their edits.
  return opts.on_save()
}
