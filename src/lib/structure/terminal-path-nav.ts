/**
 * Terminal Ctrl+click path resolution: a clicked DIRECTORY navigates the Files
 * panel (reusing the existing `catgo-terminal-cwd` window-event bus that the
 * Directory-Sync feature already listens on — see desktop/sidebar/cwd-sync.svelte.ts),
 * while a clicked FILE opens in the viewer/editor via the existing on_open_file path.
 *
 * Split out of TerminalPanel.svelte so the dir-vs-file branch is unit-testable
 * without a DOM/xterm harness.
 */
import { API_BASE } from '$lib/api/config'
import { listFiles } from '$lib/api/hpc'

/** True if `path` is a directory. Local terminal (empty session_id) → the local
 * `/workflow/files/browse` endpoint (200 = dir, 404 = not). Remote terminal →
 * `listFiles` over that session's SSH (success = dir). Any error → false, so the
 * caller safely falls back to treating it as a file (the prior behaviour). */
export async function path_is_directory(path: string, session_id: string): Promise<boolean> {
  try {
    if (session_id) {
      const res = await listFiles(session_id, path)
      return res.success
    }
    const res = await fetch(`${API_BASE}/workflow/files/browse?dir=${encodeURIComponent(path)}`)
    return res.ok
  } catch {
    return false
  }
}

export interface TerminalClickHandlers {
  /** Open a file path (structure/editor/preview) — the pre-existing behaviour. */
  open_file: (path: string) => void
  /** Navigate the Files panel for this session to `path` (a directory). */
  navigate_dir: (path: string, session_id: string) => void
}

/** Route a Ctrl+clicked, already-resolved terminal path: directory → navigate the
 * Files panel; file → open it. `is_directory` is injectable for testing. */
export async function open_terminal_click(
  path: string,
  session_id: string,
  handlers: TerminalClickHandlers,
  is_directory: (path: string, session_id: string) => Promise<boolean> = path_is_directory,
): Promise<void> {
  if (await is_directory(path, session_id)) {
    handlers.navigate_dir(path, session_id)
  } else {
    handlers.open_file(path)
  }
}
