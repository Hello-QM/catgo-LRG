<!--
  MobileFiles.svelte — read-only SFTP file browser for the mobile (tauri-ssh)
  transport.

  Given a live `session_id`, it resolves the remote home directory once
  (`echo $HOME`, falling back to `.`), lists it via `transport.sftpList`, and
  renders directories-first-then-files rows. Tapping a directory navigates into
  it; an `..` row (and the breadcrumb) navigate to the parent. Tapping a file
  opens {@link MobileFileViewer} (read-only text viewer with a binary guard).

  Loading / error states mirror MobileTerminal's mt-status / mt-error styling.
  A manual Refresh button re-lists the current directory.

  NEW + standalone: read-only browse + view; never touches the desktop path.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { transport, type SftpEntry } from '$lib/api/transport'
  import MobileFileViewer from './MobileFileViewer.svelte'
  import { humanSize, joinPath, parentPath, isStructureName } from './files-util'
  import Icon from '$lib/Icon.svelte'
  import { t } from '$lib/i18n/index.svelte'

  interface Props {
    /** Live HPC session id (from MobileConnect). */
    session_id: string
    /** Terminal's current working directory (OSC 7). When it changes, the
     * browser follows it. Empty => stay where the user navigated. */
    follow_path?: string
    /** When set, tapping a structure-format file reads it and calls this so the
     * host can open it in the 3D editor (instead of the text viewer). */
    on_open_structure?: (content: string, filename: string, path: string) => void
  }

  let { session_id, follow_path = ``, on_open_structure }: Props = $props()

  let cwd = $state(``)
  let entries = $state<SftpEntry[]>([])
  let status = $state<`init` | `loading` | `ready` | `error`>(`init`)
  let error_msg = $state(``)

  // Address-bar input (type or paste an absolute/relative path to jump there).
  let path_input = $state(``)
  // Last terminal cwd we auto-followed, so we only jump when it actually moves.
  let followed = ``

  // Open file (null => showing the listing).
  let open_file = $state<SftpEntry | null>(null)

  // Directories first, then files; each group alphabetical (case-insensitive).
  const sorted = $derived(
    [...entries].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: `base` })
    }),
  )

  const at_root = $derived(cwd === `/`)

  // Breadcrumb segments with their cumulative absolute paths.
  const crumbs = $derived.by(() => {
    if (!cwd || cwd === `/`) return [{ label: `/`, path: `/` }]
    const parts = cwd.split(`/`).filter(Boolean)
    let acc = ``
    const out = [{ label: `/`, path: `/` }]
    for (const p of parts) {
      acc = `${acc}/${p}`
      out.push({ label: p, path: acc })
    }
    return out
  })

  async function list_dir(path: string): Promise<void> {
    status = `loading`
    error_msg = ``
    try {
      const items = await transport.sftpList(session_id, path)
      // Hide the self/parent dot-entries; we provide our own `..` row.
      entries = items.filter((e) => e.name !== `.` && e.name !== `..`)
      cwd = path
      status = `ready`
    } catch (e: unknown) {
      error_msg = e instanceof Error ? e.message : String(e)
      status = `error`
    }
  }

  /** Start at the terminal's cwd if known, else resolve $HOME (fallback `.`/`/`). */
  async function init(initial: string): Promise<void> {
    status = `loading`
    error_msg = ``
    if (initial.startsWith(`/`)) {
      followed = initial
      await list_dir(initial)
      // status may be mutated by the awaited call; cast to defeat TS narrowing
      if ((status as string) !== `error`) return
    }
    let start = `.`
    try {
      const r = await transport.exec(session_id, `echo $HOME`, 10_000)
      const home = r.stdout.trim()
      if (r.code === 0 && home.startsWith(`/`)) start = home
    } catch {
      /* fall back to `.` */
    }
    await list_dir(start)
    // If `.` somehow failed, last-resort to root so the browser is never stuck.
    if ((status as string) === `error` && start !== `/`) await list_dir(`/`)
  }

  $effect(() => {
    // Re-init whenever the session changes. Read follow_path NON-reactively so
    // this only fires on session change, not on every terminal cwd update (that
    // is the separate follow effect below).
    void session_id
    init(untrack(() => follow_path))
  })

  // Follow the terminal's cwd: when OSC 7 reports a new directory, jump there —
  // but never clobber where the user manually navigated to within Files (we only
  // move when `follow_path` actually changes). untrack keeps the effect's only
  // dependency `follow_path`, so navigation (which sets `cwd`) can't re-trigger.
  $effect(() => {
    const fp = follow_path
    untrack(() => {
      if (!fp || !fp.startsWith(`/`) || fp === followed) return
      followed = fp
      open_file = null
      if (fp !== cwd) list_dir(fp)
    })
  })

  /** Jump to a typed / pasted path (absolute, or relative to the current dir). */
  function go_path(): void {
    const raw = path_input.trim()
    if (!raw) return
    const target = raw.startsWith(`/`) ? raw : joinPath(cwd, raw)
    path_input = ``
    open_file = null
    list_dir(target)
  }

  async function enter(entry: SftpEntry): Promise<void> {
    if (entry.isDir) {
      open_file = null
      list_dir(entry.path || joinPath(cwd, entry.name))
      return
    }
    const path = entry.path || joinPath(cwd, entry.name)
    // A structure file opens straight in the 3D editor (when the host wired it).
    if (on_open_structure && isStructureName(entry.name)) {
      try {
        const r = await transport.sftpRead(session_id, path, 4_000_000)
        on_open_structure(r.content, entry.name, path)
      } catch (e) {
        error_msg = e instanceof Error ? e.message : String(e)
      }
      return
    }
    open_file = entry
  }

  function go_up(): void {
    open_file = null
    list_dir(parentPath(cwd))
  }

  function go_crumb(path: string): void {
    open_file = null
    if (path !== cwd) list_dir(path)
  }

  function refresh(): void {
    if (cwd) list_dir(cwd)
  }
</script>

<div class="mobile-files">
  <header class="mf-bar">
    <nav class="mf-crumbs" aria-label={t(`mobile.aria_path`)}>
      {#each crumbs as c, i (c.path)}
        {#if i > 0}<span class="mf-sep">/</span>{/if}
        <button
          type="button"
          class="mf-crumb"
          class:current={c.path === cwd}
          onclick={() => go_crumb(c.path)}
        >
          {c.label}
        </button>
      {/each}
    </nav>
    <button
      type="button"
      class="mf-refresh"
      aria-label={t(`mobile.aria_refresh`)}
      onclick={refresh}
      disabled={status === `loading`}
    >
      <Icon icon="Reset" />
    </button>
  </header>

  <form
    class="mf-pathentry"
    onsubmit={(e) => {
      e.preventDefault()
      go_path()
    }}
  >
    <input
      type="text"
      inputmode="url"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      placeholder={t(`mobile.path_placeholder`, { user: `{user}` })}
      bind:value={path_input}
    />
    <button type="submit" class="mf-go" disabled={!path_input.trim()}>{t(`mobile.go`)}</button>
  </form>

  <div class="mf-body">
    {#if status === `loading` && entries.length === 0}
      <div class="mf-status">{t(`mobile.loading`)}</div>
    {:else if status === `error`}
      <div class="mf-error">{error_msg}</div>
    {:else}
      <ul class="mf-list">
        {#if !at_root}
          <li>
            <button type="button" class="mf-row mf-up" onclick={go_up}>
              <span class="mf-icon"><Icon icon="ArrowUp" /></span>
              <span class="mf-name">..</span>
              <span class="mf-meta">{t(`mobile.parent`)}</span>
            </button>
          </li>
        {/if}
        {#each sorted as entry (entry.path || entry.name)}
          <li>
            <button type="button" class="mf-row" onclick={() => enter(entry)}>
              <span class="mf-icon">{entry.isDir ? `📁` : `📄`}</span>
              <span class="mf-name" class:dir={entry.isDir}>{entry.name}</span>
              <span class="mf-meta">
                {entry.isDir ? `` : humanSize(entry.size)}
              </span>
            </button>
          </li>
        {/each}
        {#if sorted.length === 0}
          <li class="mf-empty">{t(`mobile.empty_directory`)}</li>
        {/if}
      </ul>
    {/if}
  </div>

  {#if open_file}
    <MobileFileViewer
      {session_id}
      path={open_file.path || joinPath(cwd, open_file.name)}
      size={open_file.size}
      on_close={() => (open_file = null)}
    />
  {/if}
</div>

<style>
  .mobile-files {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    background: var(--page-bg, #0e1117);
  }
  .mf-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .mf-crumbs {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    white-space: nowrap;
  }
  .mf-sep {
    flex-shrink: 0;
    color: var(--text-color-muted, #94a3b8);
    padding: 0 2px;
  }
  .mf-crumb {
    flex-shrink: 0;
    min-height: 36px;
    padding: 0 6px;
    font-size: 14px;
    color: var(--accent-color, #3b82f6);
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .mf-crumb.current {
    color: var(--text-color, #e0e0e0);
    font-weight: 600;
  }
  .mf-refresh {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    font-size: 20px;
    line-height: 1;
    color: var(--text-color, #e0e0e0);
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    cursor: pointer;
  }
  .mf-refresh:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .mf-pathentry {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    padding: 6px 10px;
    background: rgba(0, 0, 0, 0.18);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .mf-pathentry input {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    font-size: 16px; /* >=16px stops iOS zoom-on-focus. */
    color: var(--text-color, #e0e0e0);
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    outline: none;
  }
  .mf-pathentry input:focus {
    border-color: var(--accent-color, #3b82f6);
  }
  .mf-go {
    flex-shrink: 0;
    min-width: 52px;
    min-height: 40px;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    background: var(--accent-color, #0a84ff);
    border: 1px solid var(--accent-color, #0a84ff);
    border-radius: 8px;
    cursor: pointer;
  }
  .mf-go:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .mf-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .mf-status {
    padding: 12px;
    font-size: 0.85em;
    color: var(--text-color-muted, #94a3b8);
  }
  .mf-error {
    padding: 12px;
    font-size: 0.85em;
    color: #ff6b6b;
  }
  .mf-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .mf-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 48px;
    padding: 8px 14px;
    text-align: left;
    color: var(--text-color, #e0e0e0);
    background: transparent;
    border: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    cursor: pointer;
  }
  .mf-row:active {
    background: rgba(59, 130, 246, 0.12);
  }
  .mf-icon {
    flex-shrink: 0;
    width: 22px;
    font-size: 16px;
    text-align: center;
  }
  .mf-name {
    flex: 1;
    min-width: 0;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mf-name.dir {
    color: var(--accent-color, #3b82f6);
  }
  .mf-meta {
    flex-shrink: 0;
    font-size: 0.78em;
    color: var(--text-color-muted, #94a3b8);
    font-variant-numeric: tabular-nums;
  }
  .mf-up .mf-name {
    color: var(--text-color-muted, #94a3b8);
  }
  .mf-empty {
    padding: 16px 14px;
    font-size: 0.85em;
    color: var(--text-color-muted, #94a3b8);
  }
</style>
