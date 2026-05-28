<script lang="ts">
  /**
   * StepFileTree — output file browser for workflow step STATUS panel.
   *
   * Extracted from NodeStatusPanel for modularity. Renders the OUTPUT FILES
   * section with collapsible tree, hover action icons (view/edit/download),
   * polling controls, and work_dir path bar.
   */
  import { Icon } from '$lib'
  import * as api from '$lib/api/workflow'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('sidebar')
  load_i18n_module('structure')
  load_i18n_module('workflow')

  interface FileEntry {
    name: string
    size: string
    modified: string
    is_dir: boolean
    permissions?: string
  }

  let {
    files,
    work_dir = ``,
    status,
    node_id,
    workflow_id,
    poll_enabled = $bindable(true),
    poll_interval_ms = $bindable(15_000),
    expanded_dirs = $bindable<Record<string, FileEntry[]>>({}),
    fetch_files,     // custom file fetcher (for engine tasks)
    fetch_content,   // custom file content fetcher
    onview_file,
    onload_structure,
    ondownload,
    onrefresh,
  }: {
    files: FileEntry[]
    work_dir?: string
    status?: string
    node_id: string
    workflow_id: string
    poll_enabled?: boolean
    poll_interval_ms?: number
    expanded_dirs?: Record<string, FileEntry[]>
    fetch_files?: (subdir?: string) => Promise<{ files: FileEntry[]; work_dir: string }>
    fetch_content?: (filename: string) => Promise<{ path: string; content: string }>
    onview_file?: (node_id: string, filename: string) => void
    onload_structure?: (node_id: string, filename: string) => void
    ondownload?: (node_id: string, filename: string) => void
    onrefresh?: () => void
  } = $props()

  // Collapse state
  let collapsed = $state(false)
  let copy_feedback = $state(false)
  let file_loading = $state(false)

  const POLL_OPTIONS = [5_000, 15_000, 30_000, 60_000] as const

  // ─── File classification ───
  const STRUCTURE_FILES = new Set([`CONTCAR`, `POSCAR`, `XDATCAR`])
  const LOADABLE_FILES = new Set([`CONTCAR`, `POSCAR`, `CHGCAR`, `XDATCAR`])
  const CONFIG_FILES = new Set([`INCAR`, `KPOINTS`, `POTCAR`])
  const DATA_FILES = new Set([`DOSCAR`, `EIGENVAL`, `IBZKPT`, `PCDAT`, `PROCAR`])
  const OUTPUT_FILES = new Set([`OUTCAR`, `OSZICAR`, `REPORT`])
  const CHARGE_FILES = new Set([`CHGCAR`, `CHG`, `WAVECAR`, `AECCAR0`, `AECCAR1`, `AECCAR2`])
  const CODE_EXTS = new Set([`.py`, `.sh`, `.slurm`, `.bash`])

  function file_color(name: string, is_dir: boolean): string {
    if (is_dir) return `#6C9CFC`
    if (STRUCTURE_FILES.has(name)) return `#34D399`
    if (CONFIG_FILES.has(name)) return `#F59E0B`
    if (DATA_FILES.has(name)) return `#A78BFA`
    if (OUTPUT_FILES.has(name)) return `#60A5FA`
    if (CHARGE_FILES.has(name)) return `#F472B6`
    if (name === `vasprun.xml` || name === `vaspout.h5`) return `#F97316`
    const dot = name.lastIndexOf(`.`)
    if (dot >= 0 && CODE_EXTS.has(name.slice(dot).toLowerCase())) return `#4ADE80`
    return `#8B8D98`
  }

  function format_size(bytes: string | number): string {
    const n = typeof bytes === `string` ? parseInt(bytes) : bytes
    if (isNaN(n) || n === 0) return ``
    const units = [`B`, `KB`, `MB`, `GB`]
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
    return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
  }

  function format_poll_label(ms: number): string {
    return ms < 60_000 ? `${ms / 1000}s` : `${ms / 60_000}m`
  }

  function can_load(name: string): boolean {
    return LOADABLE_FILES.has(name) || name === `vaspout.h5`
  }

  function copy_work_dir() {
    if (!work_dir) return
    navigator.clipboard.writeText(work_dir)
    copy_feedback = true
    setTimeout(() => (copy_feedback = false), 1500)
  }

  async function toggle_dir(dir_name: string) {
    if (expanded_dirs[dir_name]) {
      delete expanded_dirs[dir_name]
      expanded_dirs = { ...expanded_dirs }
      return
    }
    try {
      file_loading = true
      const file_promise = fetch_files
        ? fetch_files(dir_name)
        : api.get_step_files(workflow_id, node_id, dir_name)
      const result = await file_promise
      expanded_dirs[dir_name] = (result.files ?? [])
        .filter((f: any) => f.name !== `.` && f.name !== `..`)
        .map((f: any) => ({ ...f, is_dir: f.permissions?.startsWith(`d`) ?? false }))
      expanded_dirs = { ...expanded_dirs }
    } catch (err) {
      console.error(`Failed to list subdir ${dir_name}:`, err)
    } finally {
      file_loading = false
    }
  }

  async function handle_click(filename: string) {
    if (fetch_content) {
      try {
        file_loading = true
        const result = await fetch_content(filename)
        onview_file?.(node_id, filename)
      } catch (err) {
        console.error(`Failed to fetch content for ${filename}:`, err)
      } finally {
        file_loading = false
      }
    } else {
      onview_file?.(node_id, filename)
    }
  }

  function handle_load(e: MouseEvent, filename: string) {
    e.stopPropagation()
    onload_structure?.(node_id, filename)
  }

  function handle_download(e: MouseEvent, filename: string) {
    e.stopPropagation()
    ondownload?.(node_id, filename)
  }
</script>

<div class="sft-section">
  <!-- Header row: title + collapse toggle + polling controls -->
  <div class="sft-header">
    <button class="sft-collapse-btn" onclick={() => (collapsed = !collapsed)}>
      <span class="sft-chevron" class:open={!collapsed}>{collapsed ? `▸` : `▾`}</span>
      <span class="sft-title">{t('workflow.nsp_output_files')}</span>
    </button>
    {#if !collapsed}
      <div class="sft-controls">
        <button class="sft-ctrl-btn" onclick={() => onrefresh?.()} title={t('workflow.refresh_now')}>&#x21BB;</button>
        {#if status === `running` || status === `queued`}
          <button
            class="sft-ctrl-btn"
            class:active={poll_enabled}
            onclick={() => (poll_enabled = !poll_enabled)}
            title={poll_enabled ? t('workflow.pause_auto_refresh') : t('workflow.resume_auto_refresh')}
          >
            {poll_enabled ? `⏸` : `▶`}
          </button>
          <select class="sft-ctrl-select" bind:value={poll_interval_ms} title={t('workflow.rc_poll_interval')}>
            {#each POLL_OPTIONS as opt}
              <option value={opt}>{format_poll_label(opt)}</option>
            {/each}
          </select>
        {/if}
      </div>
    {/if}
  </div>

  {#if !collapsed}
    <!-- Work dir path bar -->
    {#if work_dir}
      <div class="sft-path-bar">
        <span class="sft-path-text" title={work_dir}>{work_dir}</span>
        <button class="sft-copy-btn" onclick={copy_work_dir} title={t('sidebar.copy_path')}>
          {#if copy_feedback}
            <span style="color:#34D399;font-weight:700">&#x2713;</span>
          {:else}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          {/if}
        </button>
      </div>
    {/if}

    {#if file_loading}
      <div style="display:flex;align-items:center;gap:6px;padding:4px 8px;color:var(--text-color-dim,#888);font-size:11px;">
        <div style="width:14px;height:14px;border:2px solid #333;border-top-color:#3b82f6;border-radius:50%;animation:spin 0.6s linear infinite;"></div>
        {t('common.loading')}
      </div>
    {/if}

    <!-- File list -->
    {#if files.length > 0}
      <div class="sft-tree">
        {#each files as f}
          {@const color = file_color(f.name, f.is_dir)}
          {#if f.is_dir}
            <button class="sft-row" onclick={() => toggle_dir(f.name)}>
              <span class="sft-icon" style="background:{color}1a">
                <Icon icon={expanded_dirs[f.name] ? `DirectoryOpen` : `Directory`} style="width:14px;height:14px;color:{color}" />
              </span>
              <span class="sft-name">{f.name}</span>
            </button>
            {#if expanded_dirs[f.name]}
              {#each expanded_dirs[f.name] as sf}
                {@const sc = file_color(sf.name, sf.is_dir)}
                <button class="sft-row sft-sub" onclick={() => handle_click(f.name + `/` + sf.name)} title="{sf.name} ({format_size(sf.size)})">
                  <span class="sft-icon" style="background:{sc}1a">
                    <Icon icon={sf.is_dir ? `Directory` : `File`} style="width:14px;height:14px;color:{sc}" />
                  </span>
                  <span class="sft-name">{sf.name}</span>
                  <span class="sft-size">{format_size(sf.size)}</span>
                </button>
              {/each}
            {/if}
          {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="sft-row" onclick={() => handle_click(f.name)} onkeydown={(e) => e.key === 'Enter' && handle_click(f.name)} role="button" tabindex="0" title="{f.name} ({format_size(f.size)})">
              <span class="sft-icon" style="background:{color}1a">
                <Icon icon="File" style="width:14px;height:14px;color:{color}" />
              </span>
              <span class="sft-name">{f.name}</span>
              <span class="sft-size">{format_size(f.size)}</span>
              <!-- Action buttons (visible on hover) -->
              <span class="sft-actions">
                {#if can_load(f.name)}
                  <button class="sft-action" onclick={(e) => handle_load(e, f.name)} title={t('structure.load_structure')}>&#9654;</button>
                {/if}
                <button class="sft-action" onclick={(e) => handle_download(e, f.name)} title={t('common.download')}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </button>
              </span>
            </div>
          {/if}
        {/each}
      </div>
    {:else}
      <div class="sft-empty">{t('workflow.no_output_files_yet')}</div>
    {/if}
  {/if}
</div>

<style>
  .sft-section {
    padding: 0;
  }
  .sft-header {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    margin-bottom: 8px;
  }
  .sft-collapse-btn {
    display: flex; align-items: center; gap: 4px;
    background: none; border: none; cursor: pointer;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font: inherit; font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.05em; padding: 0;
  }
  .sft-collapse-btn:hover { color: var(--text-color, light-dark(#374151, #eee)); }
  .sft-chevron { font-size: 10px; width: 10px; display: inline-block; }
  .sft-title { pointer-events: none; }
  .sft-controls { display: flex; align-items: center; gap: 4px; }
  .sft-ctrl-btn {
    background: none;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 3px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-size: 11px; padding: 2px 5px; cursor: pointer;
    font-family: inherit; line-height: 1; transition: all 0.12s;
  }
  .sft-ctrl-btn:hover {
    color: var(--text-color, light-dark(#374151, #eee));
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .sft-ctrl-btn.active { color: var(--accent-color, light-dark(#4f46e5, #3b82f6)); }
  .sft-ctrl-select {
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 3px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-size: 10px; font-family: inherit; padding: 2px 4px; cursor: pointer;
  }
  .sft-ctrl-select option {
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
    color: var(--text-color, light-dark(#374151, #eee));
  }

  /* Path bar */
  .sft-path-bar {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 8px; margin-bottom: 6px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.04)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
  }
  .sft-path-text {
    flex: 1; font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    direction: rtl; text-align: left;
  }
  .sft-copy-btn {
    background: none; border: none;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    cursor: pointer; padding: 2px; border-radius: 3px;
    display: flex; align-items: center; flex-shrink: 0; transition: color 0.12s;
  }
  .sft-copy-btn:hover { color: var(--accent-color, light-dark(#4f46e5, #3b82f6)); }

  /* Tree rows */
  .sft-tree { display: flex; flex-direction: column; }
  .sft-row {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 8px; background: none; border: none;
    color: var(--text-color, light-dark(#374151, #eee));
    font-size: 12px; font-family: inherit; cursor: pointer;
    text-align: left; border-radius: 4px; transition: background 0.12s;
  }
  .sft-row:hover { background: var(--surface-bg-hover, light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.06))); }
  .sft-row:hover .sft-icon { filter: brightness(1.3); }
  .sft-row:hover .sft-actions { opacity: 1; }
  .sft-sub { padding-left: 32px; }
  .sft-icon {
    display: flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 6px;
    flex-shrink: 0; transition: filter 0.15s ease;
  }
  .sft-name {
    flex: 1; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
    font-size: 0.8em;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
  }
  .sft-size {
    font-size: 0.65em;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    white-space: nowrap; flex-shrink: 0; margin-left: auto; padding-left: 6px;
  }

  /* Hover action buttons */
  .sft-actions {
    display: flex; gap: 2px; opacity: 0; transition: opacity 0.12s;
    flex-shrink: 0; margin-left: auto;
  }
  .sft-action {
    background: none; border: none; cursor: pointer; padding: 2px 4px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    border-radius: 3px; font-size: 10px; display: flex; align-items: center;
    transition: color 0.12s, background 0.12s;
  }
  .sft-action:hover {
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    background: var(--surface-bg-hover, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.08)));
  }

  .sft-empty {
    font-size: 11px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-style: italic; padding: 8px 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
