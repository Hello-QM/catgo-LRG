/**
 * Keep-screen-awake preference + applier for the mobile terminal.
 *
 * iOS auto-locks the screen after its idle timeout; an auto-lock backgrounds the
 * app, which iOS then suspends — dropping the SSH connection. While the user is
 * in a terminal we disable the idle timer (UIApplication.isIdleTimerDisabled via
 * the bg-grace plugin) so the screen stays on and the connection survives. This
 * only covers the "I'm watching a job and the screen locked itself" case; a
 * MANUAL lock or a long app-switch still suspends the app (an iOS rule no app can
 * bypass — see the session-stability research).
 *
 * Default ON; the toggle persists in localStorage. Module-scope `$state` so the
 * toggle (in the terminal key bar) and the applier (in MobileWorkspace) share it.
 */

import { invoke } from '@tauri-apps/api/core'
import { check_tauri } from '$lib/io/tauri'

const KEY = `catgo.keep_screen_awake`

function load_pref(): boolean {
  try {
    // Absent key → default ON; only an explicit "0" disables it.
    return globalThis.localStorage?.getItem(KEY) !== `0`
  } catch {
    return true
  }
}

export const screen_wake = $state({ enabled: load_pref() })

export function set_keep_awake(enabled: boolean): void {
  screen_wake.enabled = enabled
  try {
    globalThis.localStorage?.setItem(KEY, enabled ? `1` : `0`)
  } catch {
    /* storage unavailable — the in-memory pref still applies this run */
  }
}

// Track the last value we sent to the OS so we don't spam the bridge with
// no-op invokes (the applier runs on every visibility/session change).
let applied: boolean | null = null

/** Set the OS idle-timer state. `awake` = a terminal is foreground AND the pref
 *  is on. Safe to call anywhere: a no-op off-mobile / on the desktop transport. */
export async function apply_idle_timer(awake: boolean): Promise<void> {
  if (awake === applied) return
  applied = awake
  if (!check_tauri()) return
  try {
    await invoke(`plugin:bg-grace|set_idle_timer`, { disabled: awake })
  } catch {
    /* desktop / unsupported platform — ignore */
  }
}
