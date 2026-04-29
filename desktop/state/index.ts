/**
 * Desktop app state modules — grouped $state variables extracted from App.svelte.
 *
 * Each module exports a singleton reactive object:
 *   sidebar  — sidebar UI, editor overlay, preview overlay, paths
 *   exp      — export/save dialog, filesystem browser, close-save state
 *   modal    — search, paste, OPTIMADE, plugins, close-all dialogs
 *   terminal — terminal init params (session, host, username, cwd sync)
 */

export { sidebar } from './sidebar-state.svelte'
export { exp } from './export-state.svelte'
export { modal, type CloseAllEntry } from './modal-state.svelte'
export { terminal } from './terminal-state.svelte'
