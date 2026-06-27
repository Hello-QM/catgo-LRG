// Desktop in-app auto-update (Svelte 5 runes store + actions).
//
// Windows/macOS: the Tauri updater plugin self-installs a signed bundle and the
// app relaunches (mode 'auto'). Linux ships .deb/.rpm, which the updater can't
// self-install — there we only compare versions against the latest GitHub
// release and point the user at the download page (mode 'manual').
//
// All of this is desktop-only: the updater/process plugins are not compiled on
// mobile, and the web (STATIC_ONLY) build has no Tauri at all — both are gated
// out by `is_desktop_tauri()` so this module is inert there.

import { check_tauri } from '$lib/io/tauri'

const REPO = `Hello-QM/catgo-LRG`
const RELEASES_LATEST_PAGE = `https://github.com/${REPO}/releases/latest`
const RELEASES_LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`

export type UpdateStatus =
  | `idle`
  | `checking`
  | `available`
  | `downloading`
  | `ready`
  | `error`
  | `none`

/** 'auto' = one-click download+install (Win/macOS); 'manual' = open download page (Linux). */
export type UpdateMode = `auto` | `manual`

interface UpdateState {
  status: UpdateStatus
  version: string | null
  notes: string | null
  mode: UpdateMode
  progress: number // 0..1, only meaningful while downloading
  error: string | null
  dismissed: boolean
}

export const update_state = $state<UpdateState>({
  status: `idle`,
  version: null,
  notes: null,
  mode: `auto`,
  progress: 0,
  error: null,
  dismissed: false,
})

// The Tauri Update handle (Win/macOS) is kept out of the reactive store — it
// carries non-cloneable internals and we only need it for downloadAndInstall().
let pending_update: { downloadAndInstall: (cb?: (e: unknown) => void) => Promise<void> } | null =
  null

function is_mobile_ua(): boolean {
  const ua = (typeof navigator !== `undefined` && navigator.userAgent) || ``
  return /Android|iPhone|iPad|iPod/i.test(ua)
}

function is_linux_ua(): boolean {
  const ua = (typeof navigator !== `undefined` && navigator.userAgent) || ``
  return /Linux/i.test(ua) && !/Android/i.test(ua)
}

/** True only inside the desktop Tauri shell (not web, not mobile). */
export function is_desktop_tauri(): boolean {
  return check_tauri() && !is_mobile_ua()
}

/** Strip a leading `v` and any prerelease/build suffix, keep the numeric core. */
function normalize_version(v: string): number[] {
  const core = v.replace(/^v/i, ``).split(/[-+]/)[0]
  return core.split(`.`).map((n) => parseInt(n, 10) || 0)
}

/** True when `latest` is a strictly newer semantic version than `current`. */
function is_newer(latest: string, current: string): boolean {
  const a = normalize_version(latest)
  const b = normalize_version(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

/** Linux path: compare the running version to the latest GitHub release tag. */
async function check_linux(): Promise<void> {
  const { getVersion } = await import(`@tauri-apps/api/app`)
  const current = await getVersion()
  // plugin-http honours the capability HTTP scope; falls back to fetch in dev.
  let tag: string | null = null
  let body: string | null = null
  try {
    const { fetch: tauriFetch } = await import(`@tauri-apps/plugin-http`)
    const res = await tauriFetch(RELEASES_LATEST_API, { method: `GET` })
    const json = await res.json()
    tag = json?.tag_name ?? null
    body = json?.body ?? null
  } catch {
    const res = await fetch(RELEASES_LATEST_API)
    const json = await res.json()
    tag = json?.tag_name ?? null
    body = json?.body ?? null
  }
  if (tag && is_newer(tag, current)) {
    update_state.status = `available`
    update_state.version = tag.replace(/^v/i, ``)
    update_state.notes = body
    update_state.mode = `manual`
  } else {
    update_state.status = `none`
  }
}

/** Windows/macOS path: the signed Tauri updater check. */
async function check_auto(): Promise<void> {
  const { check } = await import(`@tauri-apps/plugin-updater`)
  const update = await check()
  if (update && update.available) {
    pending_update = update as unknown as typeof pending_update
    update_state.status = `available`
    update_state.version = update.version
    update_state.notes = update.body ?? null
    update_state.mode = `auto`
  } else {
    update_state.status = `none`
  }
}

/**
 * Check for an update. No-op outside the desktop Tauri shell. Safe to call on
 * startup; failures are swallowed into `update_state.error` and never throw.
 */
export async function check_for_updates(): Promise<void> {
  if (!is_desktop_tauri()) return
  if (update_state.status === `checking` || update_state.status === `downloading`) return
  update_state.status = `checking`
  update_state.error = null
  try {
    if (is_linux_ua()) {
      await check_linux()
    } else {
      await check_auto()
    }
  } catch (err) {
    update_state.status = `error`
    update_state.error = err instanceof Error ? err.message : String(err)
    console.error(`[auto-update] check failed:`, err)
  }
}

/**
 * Act on an available update. Win/macOS: download the signed bundle (driving the
 * progress bar) then relaunch into the new version. Linux: open the download
 * page in the system browser.
 */
export async function install_update(): Promise<void> {
  if (update_state.mode === `manual`) {
    try {
      const { openUrl } = await import(`@tauri-apps/plugin-opener`)
      await openUrl(RELEASES_LATEST_PAGE)
    } catch (err) {
      console.error(`[auto-update] failed to open download page:`, err)
      if (typeof window !== `undefined`) window.open(RELEASES_LATEST_PAGE, `_blank`)
    }
    return
  }

  if (!pending_update) return
  update_state.status = `downloading`
  update_state.progress = 0
  try {
    let downloaded = 0
    let total = 0
    await pending_update.downloadAndInstall((event: unknown) => {
      const e = event as { event: string; data?: { contentLength?: number; chunkLength?: number } }
      if (e.event === `Started`) {
        total = e.data?.contentLength ?? 0
      } else if (e.event === `Progress`) {
        downloaded += e.data?.chunkLength ?? 0
        update_state.progress = total > 0 ? downloaded / total : 0
      } else if (e.event === `Finished`) {
        update_state.progress = 1
      }
    })
    update_state.status = `ready`
    const { relaunch } = await import(`@tauri-apps/plugin-process`)
    await relaunch()
  } catch (err) {
    update_state.status = `error`
    update_state.error = err instanceof Error ? err.message : String(err)
    console.error(`[auto-update] install failed:`, err)
  }
}

/** Hide the banner until the next check finds another version. */
export function dismiss_update(): void {
  update_state.dismissed = true
}
