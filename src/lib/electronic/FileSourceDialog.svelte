<script lang="ts">
  import '$lib/dialog-shared.css'
  import { API_BASE } from '$lib/api/config'
  import { Spinner } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')

  let {
    show = $bindable(false),
    file_types = [`.h5`, `.hdf5`],
    title = ``,
    description = ``,
    onfile,
    onremote_path,
    onclose,
  }: {
    show?: boolean
    file_types?: string[]
    title?: string
    description?: string
    onfile?: (file: File) => void
    onremote_path?: (session_id: string, path: string) => void
    onclose?: () => void
  } = $props()

  // ─── Tab state ───
  let active_tab = $state<`local` | `remote` | `workflow`>(`local`)
  let loading = $state(false)
  let error_msg = $state(``)

  // ─── Remote tab state ───
  let sessions = $state<Array<{ id: string; host: string; username: string }>>([])
  let selected_session = $state(``)
  let remote_path = $state(``)

  // ─── Workflow tab state ───
  let workflows = $state<Array<{ id: string; name: string; status: string }>>([])
  let selected_workflow = $state(``)
  let steps = $state<Array<{ id: string; node_type: string; label: string; status: string; work_dir?: string }>>([])
  let selected_step = $state(``)
  let step_files = $state<Array<{ name: string; size: string }>>([])
  let selected_file = $state(``)

  // ─── Drag state ───
  let dragging = $state(false)

  // ─── Derived ───
  let accept_string = $derived(file_types.join(`,`))
  let is_binary_only = $derived(
    file_types.every((ft) => [`.h5`, `.hdf5`, `.nc`, `.npz`].includes(ft))
  )

  // ─── Load data when dialog opens or tab changes ───
  $effect(() => {
    if (!show) return
    error_msg = ``
    if (active_tab === `remote`) {
      fetch_sessions()
    } else if (active_tab === `workflow`) {
      fetch_workflows()
    }
  })

  // ─── Load steps when workflow is selected ───
  $effect(() => {
    if (selected_workflow) {
      fetch_steps(selected_workflow)
    } else {
      steps = []
      selected_step = ``
      step_files = []
      selected_file = ``
    }
  })

  // ─── Load files when step is selected ───
  $effect(() => {
    if (selected_workflow && selected_step) {
      fetch_step_files(selected_workflow, selected_step)
    } else {
      step_files = []
      selected_file = ``
    }
  })

  // ─── API calls ───
  async function fetch_sessions() {
    try {
      const resp = await fetch(`${API_BASE}/hpc/connections`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      const conns = data.connections || data || []
      sessions = conns.map((c: any) => ({
        id: c.session_id || c.id,
        host: c.host,
        username: c.username,
      }))
      if (sessions.length > 0 && !selected_session) {
        selected_session = sessions[0].id
      }
    } catch (e: any) {
      sessions = []
    }
  }

  async function fetch_workflows() {
    try {
      const resp = await fetch(`${API_BASE}/workflow/`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data: Array<{ id: string; name: string; status: string }> = await resp.json()
      workflows = data
    } catch (e: any) {
      workflows = []
    }
  }

  async function fetch_steps(workflow_id: string) {
    steps = []
    selected_step = ``
    step_files = []
    selected_file = ``
    try {
      const resp = await fetch(
        `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/steps`,
      )
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data: Array<{ id: string; node_type: string; label: string; status: string; work_dir?: string }> = await resp.json()
      // Only show steps that have completed (likely have output files)
      steps = data.filter((s) => s.status === `completed` || s.status === `done`)
    } catch (e: any) {
      steps = []
    }
  }

  async function fetch_step_files(workflow_id: string, step_id: string) {
    step_files = []
    selected_file = ``
    try {
      const resp = await fetch(
        `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/steps/${encodeURIComponent(step_id)}/files`,
      )
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      const all_files: Array<{ name: string; size: string }> = data.files || data || []
      // Filter to matching file types if any filter specified
      if (file_types.length > 0) {
        step_files = all_files.filter((f) =>
          file_types.some((ext) => f.name.toLowerCase().endsWith(ext)),
        )
        // If no matches found, show all files so user can still choose
        if (step_files.length === 0) step_files = all_files
      } else {
        step_files = all_files
      }
    } catch (e: any) {
      step_files = []
    }
  }

  // ─── File handling ───
  function emit_file(file: File) {
    onfile?.(file)
    close_dialog()
  }

  function close_dialog() {
    show = false
    error_msg = ``
    loading = false
    onclose?.()
  }

  function validate_file(file: File): boolean {
    if (file_types.length === 0) return true
    const name = file.name.toLowerCase()
    return file_types.some((ext) => name.endsWith(ext))
  }

  // ─── Tab 1: Local Upload ───
  function handle_file_input(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    if (!validate_file(file)) {
      error_msg = t('common.invalid_file_type_expected', { types: file_types.join(`, `) })
      return
    }
    emit_file(file)
  }

  function handle_drop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    const file = e.dataTransfer?.files[0]
    if (!file) return
    if (!validate_file(file)) {
      error_msg = t('common.invalid_file_type_expected', { types: file_types.join(`, `) })
      return
    }
    emit_file(file)
  }

  function handle_dragover(e: DragEvent) {
    e.preventDefault()
    dragging = true
  }

  function handle_dragleave() {
    dragging = false
  }

  // ─── Known target filenames per file type ───
  const TARGET_FILE_MAP: Record<string, string[]> = {
    '.h5': [`vaspout.h5`],
    '.hdf5': [`vaspout.h5`],
    '.xml': [`vasprun.xml`],
    '.lobster': [`COHPCAR.lobster`],
    '.txt': [`COHPCAR.lobster`],
    'PROCAR': [`PROCAR`],
    'XDATCAR': [`XDATCAR`],
    '.xyz': [],
    '.extxyz': [],
    '.traj': [],
  }

  function get_target_filenames(): string[] {
    const targets = new Set<string>()
    for (const ext of file_types) {
      for (const name of TARGET_FILE_MAP[ext] ?? []) targets.add(name)
    }
    return [...targets]
  }

  /** Resolve path: if it's a directory, auto-find the target file inside. */
  async function resolve_remote_path(path: string): Promise<string> {
    const targets = get_target_filenames()
    if (targets.length === 0) return path

    const params = new URLSearchParams({
      session_id: selected_session,
      remote_path: path,
      targets: targets.join(`,`),
    })
    const resp = await fetch(`${API_BASE}/hpc/resolve-file?${params}`)
    if (!resp.ok) return path

    const data = await resp.json()
    if (data.is_dir && !data.found) {
      const hint = data.files?.length
        ? `\n${t('common.files_found')}: ${data.files.slice(0, 10).join(`, `)}`
        : ``
      throw new Error(
        t('common.directory_missing_targets', { targets: targets.join(` or `), hint })
      )
    }
    return data.resolved_path
  }

  // ─── Tab 2: Remote download ───
  async function download_remote() {
    if (!selected_session || !remote_path.trim()) {
      error_msg = t('common.select_session_enter_path')
      return
    }
    loading = true
    error_msg = ``

    try {
      // If caller wants to handle remote path directly (e.g. from-directory),
      // pass the raw path without downloading
      if (onremote_path) {
        onremote_path(selected_session, remote_path.trim())
        close_dialog()
        return
      }

      // Resolve directory → file if needed
      const resolved = await resolve_remote_path(remote_path.trim())

      // Try the binary download endpoint first
      const url = `${API_BASE}/hpc/download?session_id=${encodeURIComponent(selected_session)}&remote_path=${encodeURIComponent(resolved)}`
      const resp = await fetch(url)

      if (!resp.ok) {
        // If download endpoint fails and it's a text file, try text read
        if (!is_binary_only) {
          await download_remote_as_text(resolved)
          return
        }
        throw new Error(t('common.download_failed_reason', { reason: resp.statusText }))
      }

      const blob = await resp.blob()
      const filename = resolved.split(`/`).pop() || `file`
      const file = new File([blob], filename, { type: blob.type || `application/octet-stream` })
      emit_file(file)
    } catch (e: any) {
      // Fallback for text files
      if (!is_binary_only) {
        try {
          const resolved = await resolve_remote_path(remote_path.trim())
          await download_remote_as_text(resolved)
          return
        } catch {
          // fall through to error
        }
      }
      error_msg = e.message || t('common.download_failed')
    } finally {
      loading = false
    }
  }

  async function download_remote_as_text(resolved_path?: string) {
    const file_path = resolved_path || remote_path.trim()
    // For text-based files (COHPCAR.lobster, etc.), read as text and wrap in File
    const resp = await fetch(`${API_BASE}/hpc/files/read-content`, {
      method: `POST`,
      headers: { 'Content-Type': `application/json` },
      body: JSON.stringify({
        session_id: selected_session,
        file_path,
      }),
    })

    if (!resp.ok) {
      throw new Error(t('common.read_failed_reason', { reason: resp.statusText }))
    }

    const data = await resp.json()
    const content = data.content || data.text || ``
    const filename = file_path.split(`/`).pop() || `file`
    const file = new File([content], filename, { type: `text/plain` })
    emit_file(file)
  }

  // ─── Tab 3: Workflow file load ───
  async function load_workflow_file() {
    if (!selected_workflow || !selected_step || !selected_file) {
      error_msg = t('common.select_workflow_step_file')
      return
    }
    loading = true
    error_msg = ``

    try {
      const resp = await fetch(
        `${API_BASE}/workflow/${encodeURIComponent(selected_workflow)}/steps/${encodeURIComponent(selected_step)}/output/${encodeURIComponent(selected_file)}`,
      )
      if (!resp.ok) throw new Error(t('common.failed_fetch_file_reason', { reason: resp.statusText }))

      const data = await resp.json()
      const content = data.content || ``
      const file = new File([content], selected_file, { type: `text/plain` })
      emit_file(file)
    } catch (e: any) {
      error_msg = e.message || t('common.failed_load_workflow_file')
    } finally {
      loading = false
    }
  }

  // ─── Dialog interactions ───
  function handle_backdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      close_dialog()
    }
  }

  function handle_keydown(e: KeyboardEvent) {
    if (e.key === `Escape`) {
      close_dialog()
    }
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="backdrop dialog-backdrop"
    onclick={handle_backdrop}
    onkeydown={handle_keydown}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div class="modal dialog-modal">
      <!-- Header -->
      <div class="modal-header">
        <h2 class="modal-title">{title || t('common.select_file')}</h2>
        <button class="close-btn" onclick={close_dialog}>&times;</button>
      </div>

      {#if description}
        <p class="modal-description">{description}</p>
      {/if}

      <!-- Tab bar -->
      <div class="tab-bar">
        <button
          class="tab"
          class:active={active_tab === `local`}
          onclick={() => { active_tab = `local`; error_msg = `` }}
        >{t('common.local_upload')}</button>
        <button
          class="tab"
          class:active={active_tab === `remote`}
          onclick={() => { active_tab = `remote`; error_msg = `` }}
        >{t('common.browse_server')}</button>
        <button
          class="tab"
          class:active={active_tab === `workflow`}
          onclick={() => { active_tab = `workflow`; error_msg = `` }}
        >{t('common.from_workflow')}</button>
      </div>

      <!-- Tab content -->
      <div class="modal-body">

        <!-- Tab 1: Local Upload -->
        {#if active_tab === `local`}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="drop-zone"
            class:dragging
            ondragover={handle_dragover}
            ondragleave={handle_dragleave}
            ondrop={handle_drop}
            role="region"
          >
            <div class="drop-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <p class="drop-text">{t('common.drag_drop_file_here')}</p>
            <p class="drop-hint">{t('common.or')}</p>
            <label class="browse-btn">
              {t('common.browse_files')}
              <input
                type="file"
                accept={accept_string}
                onchange={handle_file_input}
                hidden
              />
            </label>
            <p class="file-hint">{t('common.accepted_types', { types: file_types.join(`, `) })}</p>
          </div>

        <!-- Tab 2: Browse Server -->
        {:else if active_tab === `remote`}
          <div class="remote-content">
            <!-- Session selector -->
            <div class="field">
              <label class="field-label">{t('common.connection')}</label>
              {#if sessions.length === 0}
                <div class="empty-state">{t('common.no_connections_available')}</div>
              {:else}
                <select class="input select" bind:value={selected_session}>
                  {#each sessions as s}
                    <option value={s.id}>
                      {s.id === '__local__' ? t('common.local_machine_host', { host: s.host }) : `${s.username}@${s.host}`}
                    </option>
                  {/each}
                </select>
              {/if}
            </div>

            <!-- Remote path input -->
            <div class="field">
              <label class="field-label">{t('common.file_or_directory_path')}</label>
              <input
                class="input"
                type="text"
                placeholder="~/calculations/static/"
                bind:value={remote_path}
              />
            </div>

            {#if !remote_path.trim()}
              <div class="info-text">
                {t('common.file_path_auto_find_hint', { types: file_types.join(`, `) })}
              </div>
            {/if}

            <button
              class="btn btn-primary"
              onclick={download_remote}
              disabled={loading || !selected_session || !remote_path.trim()}
            >
              {#if loading}
                <Spinner /> {t('common.downloading')}
              {:else}
                {t('common.download_and_load')}
              {/if}
            </button>
          </div>

        <!-- Tab 3: From Workflow -->
        {:else if active_tab === `workflow`}
          <div class="workflow-content">
            <!-- Workflow selector -->
            <div class="field">
              <label class="field-label">{t('common.workflow')}</label>
              {#if workflows.length === 0}
                <div class="empty-state">{t('common.no_workflows_found')}</div>
              {:else}
                <select class="input select" bind:value={selected_workflow}>
                  <option value="">{t('common.select_workflow_placeholder')}</option>
                  {#each workflows as wf}
                    <option value={wf.id}>{wf.name} ({wf.status})</option>
                  {/each}
                </select>
              {/if}
            </div>

            <!-- Step selector -->
            {#if selected_workflow}
              <div class="field">
                <label class="field-label">{t('common.completed_step')}</label>
                {#if steps.length === 0}
                  <div class="empty-state">{t('common.no_completed_steps_with_outputs')}</div>
                {:else}
                  <select class="input select" bind:value={selected_step}>
                    <option value="">{t('common.select_step_placeholder')}</option>
                    {#each steps as step}
                      <option value={step.id}>{step.label} ({step.node_type})</option>
                    {/each}
                  </select>
                {/if}
              </div>
            {/if}

            <!-- File selector -->
            {#if selected_step}
              <div class="field">
                <label class="field-label">{t('common.output_file')}</label>
                {#if step_files.length === 0}
                  <div class="empty-state">{t('common.no_matching_output_files')}</div>
                {:else}
                  <select class="input select" bind:value={selected_file}>
                    <option value="">{t('common.select_file_placeholder')}</option>
                    {#each step_files as f}
                      <option value={f.name}>{f.name} ({f.size})</option>
                    {/each}
                  </select>
                {/if}
              </div>
            {/if}

            <button
              class="btn btn-primary"
              onclick={load_workflow_file}
              disabled={loading || !selected_workflow || !selected_step || !selected_file}
            >
              {#if loading}
                <Spinner /> {t('common.loading')}
              {:else}
                {t('common.load_file')}
              {/if}
            </button>
          </div>
        {/if}

        <!-- Error display -->
        {#if error_msg}
          <div class="error-msg">{error_msg}</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* .backdrop - layout handled by dialog-shared.css via .dialog-backdrop */

  .modal {
    max-width: 520px;
    width: 95%;
    max-height: 85vh;
  }

  .modal-header {
    padding: 16px 20px 12px;
    flex-shrink: 0;
    border-bottom: none;
  }

  .modal-title {
    font-size: 15px;
    letter-spacing: 0.3px;
  }

  .close-btn {
    font-size: 20px;
    padding: 2px 6px;
    font-family: inherit;
  }

  .modal-description {
    margin: 0;
    padding: 0 20px 8px;
    font-size: 12px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    line-height: 1.5;
  }

  /* ─── Tab bar ─── */
  .tab-bar {
    padding: 0 20px;
    gap: 0;
    flex-shrink: 0;
  }

  .tab {
    padding: 8px 16px;
    font-family: inherit;
    font-weight: 500;
    white-space: nowrap;
  }

  /* ─── Modal body ─── */
  .modal-body {
    padding: 16px 20px 20px;
  }

  /* ─── Drop zone (Tab 1) ─── */
  .drop-zone {
    border-radius: 10px;
    padding: 32px 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
    transition: border-color 0.2s, background 0.2s;
    cursor: default;
  }
  .drop-zone:hover,
  .drop-zone.dragging {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 5%, transparent);
  }

  .drop-icon {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    margin-bottom: 4px;
  }
  .drop-zone:hover .drop-icon,
  .drop-zone.dragging .drop-icon {
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }

  .drop-text {
    margin: 0;
    font-size: 13px;
    color: var(--text-color, light-dark(#374151, #eee));
    font-weight: 500;
  }

  .drop-hint {
    margin: 0;
  }

  .browse-btn {
    display: inline-block;
    padding: 7px 18px;
    background: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: #fff;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    transition: background 0.15s;
  }
  .browse-btn:hover {
    background: var(--accent-hover-color, light-dark(#3730a3, #2563eb));
  }

  .file-hint {
    margin: 8px 0 0;
    font-size: 10px;
  }

  /* ─── Shared form elements ─── */
  .field {
    margin-bottom: 12px;
  }

  .field-label {
    display: block;
    font-weight: 600;
    letter-spacing: 0.8px;
    margin-bottom: 5px;
  }

  .input {
    font-size: 12px;
    outline: none;
  }

  .select {
    appearance: none;
    cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23484f58'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 28px;
  }

  .empty-state {
    padding: 10px 12px;
    font-size: 12px;
  }

  .info-text {
    padding: 8px 10px;
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent-color, #3b82f6) 20%, transparent);
    border-radius: 6px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-size: 11px;
    line-height: 1.5;
    margin-bottom: 12px;
  }

  /* ─── Buttons ─── */
  .btn {
    padding: 8px 18px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid;
    font-family: inherit;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    margin-top: 4px;
  }

  .btn-primary {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }

  /* ─── Remote / Workflow content ─── */
  .remote-content,
  .workflow-content {
    display: flex;
    flex-direction: column;
  }

  /* ─── Error message ─── */
  .error-msg {
    margin-top: 12px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--error-color, #ef4444) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--error-color, #ef4444) 25%, transparent);
    border-radius: 6px;
    line-height: 1.5;
  }
</style>
