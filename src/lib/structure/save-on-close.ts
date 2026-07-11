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

// Window-close guard for the WEB build. Given a `beforeunload` event and whether
// any tab is modified, block the unload (native browser "Leave site?" prompt)
// when there are unsaved edits. Returns true if the unload was blocked. Browsers
// ignore any custom UI here, so the native confirmation is all we can surface.
export function apply_beforeunload_guard(
  event: { preventDefault(): void; returnValue: unknown },
  any_modified: boolean,
): boolean {
  if (!any_modified) return false
  event.preventDefault()
  // Chrome/legacy browsers only raise the confirmation when returnValue is set.
  event.returnValue = ``
  return true
}
