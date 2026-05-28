<script lang="ts">
  import { listFiles, type RemoteFile } from '$lib/api/hpc'
  import { Icon } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { untrack } from 'svelte'
  import { slide } from 'svelte/transition'

  load_i18n_module('common')
  load_i18n_module('app')
  load_i18n_module('sidebar')
  load_i18n_module('structure')

  let {
    session_id,
    root_path = `~`,
    on_load_structure,
    on_open_editor,
    on_preview_file,
    on_load_trajectory,
    on_navigate,
    on_download,
    on_copy_path,
    on_mkdir,
    on_delete,
    on_rename,
    on_copy_file,
    on_move_file,
    on_upload,
    on_analyze_report,
    merging_dir = null,
    merge_status = null,
  }: {
    session_id: string
    root_path?: string
    on_load_structure?: (file: RemoteFile) => void
    on_open_editor?: (file: RemoteFile) => void
    on_preview_file?: (file: RemoteFile, preview_type: `image` | `pdf` | `markdown` | `csv` | `excel`) => void
    on_load_trajectory?: (dir: RemoteFile, pattern: string) => void
    on_navigate?: (path: string) => void
    on_download?: (file: RemoteFile) => void
    on_copy_path?: (file: RemoteFile) => void
    on_mkdir?: (parent_path: string, name: string) => Promise<void>
    on_delete?: (file: RemoteFile) => Promise<void>
    on_rename?: (file: RemoteFile, new_name: string) => Promise<void>
    on_copy_file?: (source: RemoteFile, dest_path: string) => Promise<void>
    on_move_file?: (source: RemoteFile, dest_path: string) => Promise<void>
    /** Upload local files to a remote directory. */
    on_upload?: (files: File[], dest_path: string) => Promise<void>
    /** Analyze a REPORT file for slow-growth post-processing. */
    on_analyze_report?: (file: RemoteFile) => void
    /** Directory name currently being merged (null = idle). */
    merging_dir?: string | null
    /** Status message after merge attempt (null = idle). */
    merge_status?: { type: `success` | `error`, message: string } | null
  } = $props()

  let copy_feedback = $state<string | null>(null)
  let copy_feedback_timer: ReturnType<typeof setTimeout> | null = null

  const MERGE_PATTERNS = [`CONTCAR`, `POSCAR`, `XDATCAR`]
  let merge_menu_path = $state<string | null>(null)

  // ====== Context menu + file operations state ======
  let ctx_menu = $state<{ x: number; y: number; node: TreeNode } | null>(null)
  let clipboard = $state<{ file: RemoteFile; op: `copy` | `cut` } | null>(null)
  let renaming_node = $state<TreeNode | null>(null)
  let rename_value = $state(``)
  let new_folder_parent = $state<string | null>(null)
  let new_folder_name = $state(``)
  let delete_confirm_file = $state<RemoteFile | null>(null)
  let op_loading = $state(false)

  function open_ctx_menu(e: MouseEvent, node: TreeNode) {
    e.preventDefault()
    e.stopPropagation()
    ctx_menu = { x: e.clientX, y: e.clientY, node }
  }

  function close_ctx_menu() { ctx_menu = null }

  async function do_new_folder(parent_path: string) {
    if (!on_mkdir || !new_folder_name.trim()) return
    op_loading = true
    try {
      const sep = parent_path.endsWith(`/`) ? `` : `/`
      await on_mkdir(parent_path, new_folder_name.trim())
      new_folder_parent = null
      new_folder_name = ``
      // Refresh current directory
      await load_root(current_root)
    } catch (e) {
      console.error(`mkdir failed:`, e)
    } finally {
      op_loading = false
    }
  }

  async function do_rename() {
    if (!on_rename || !renaming_node || !rename_value.trim()) return
    op_loading = true
    try {
      await on_rename(renaming_node.file, rename_value.trim())
      renaming_node = null
      rename_value = ``
      await load_root(current_root)
    } catch (e) {
      console.error(`rename failed:`, e)
    } finally {
      op_loading = false
    }
  }

  async function do_delete() {
    if (!on_delete || !delete_confirm_file) return
    op_loading = true
    try {
      await on_delete(delete_confirm_file)
      delete_confirm_file = null
      await load_root(current_root)
    } catch (e) {
      console.error(`delete failed:`, e)
    } finally {
      op_loading = false
    }
  }

  async function do_paste() {
    if (!clipboard) return
    const dest = current_root.endsWith(`/`) ? `${current_root}${clipboard.file.name}` : `${current_root}/${clipboard.file.name}`
    op_loading = true
    try {
      if (clipboard.op === `copy` && on_copy_file) {
        await on_copy_file(clipboard.file, dest)
      } else if (clipboard.op === `cut` && on_move_file) {
        await on_move_file(clipboard.file, dest)
        clipboard = null
      }
      await load_root(current_root)
    } catch (e) {
      console.error(`paste failed:`, e)
    } finally {
      op_loading = false
    }
  }

  function start_new_folder_inline() {
    new_folder_parent = current_root
    new_folder_name = t('sidebar.new_folder')
  }

  // ====== Drag-and-drop upload ======
  let drop_target_path = $state<string | null>(null)

  function handle_dragover(e: DragEvent, dest_path: string) {
    if (!on_upload || !e.dataTransfer?.types.includes(`Files`)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = `copy`
    drop_target_path = dest_path
  }

  function handle_dragleave(e: DragEvent) {
    // Only clear if leaving to an element outside the current drop target
    const related = e.relatedTarget as HTMLElement | null
    if (related && (e.currentTarget as HTMLElement)?.contains(related)) return
    drop_target_path = null
  }

  async function handle_drop(e: DragEvent, dest_path: string) {
    e.preventDefault()
    e.stopPropagation()
    drop_target_path = null
    if (!on_upload || !e.dataTransfer?.files.length) return
    const files = Array.from(e.dataTransfer.files)
    await on_upload(files, dest_path)
    await load_root(current_root)
  }

  // ====== Loadable / editable detection ======

  const LOADABLE_EXTS = [`.cif`, `.poscar`, `.vasp`, `.contcar`, `.xyz`, `.json`, `.extxyz`, `.inp`, `.restart`, `.traj`, `.h5`, `.hdf5`, `.xtc`, `.lammpstrj`, `.xml`, `.cube`, `.cub`]
  const LOADABLE_BASENAMES = [`poscar`, `contcar`, `xdatcar`, `chgcar`, `aeccar0`, `aeccar1`, `aeccar2`, `locpot`, `elfcar`, `parchg`]

  function is_loadable(name: string): boolean {
    const lower = name.toLowerCase()
    const base = lower.split(`/`).pop() || ``
    if (LOADABLE_BASENAMES.includes(base)) return true
    // Also match CHGCAR variants like CHGCAR_sum, AECCAR0.vasp, etc.
    if (/chgcar|aeccar|locpot|elfcar|parchg/i.test(base)) return true
    return LOADABLE_EXTS.some((ext) => lower.endsWith(ext))
  }

  const TEXT_EXTS = [
    `.txt`, `.log`, `.out`, `.err`, `.sh`, `.bash`, `.zsh`,
    `.py`, `.yaml`, `.yml`, `.toml`, `.json`, `.xml`,
    `.inp`, `.pwi`, `.pwo`, `.in`, `.dat`, `.cfg`, `.sb`,
    `.cif`, `.vasp`, `.xyz`, `.extxyz`,
    `.slurm`, `.pbs`, `.sub`, `.job`, `.cmd`,
    `.rst`, `.tex`, `.bib`,
    `.c`, `.cpp`, `.h`, `.hpp`, `.f90`, `.f`, `.rs`, `.go`, `.java`,
  ]
  const VASP_NAMES = [
    `incar`, `poscar`, `contcar`, `kpoints`, `potcar`,
    `outcar`, `oszicar`, `doscar`, `eigenval`, `ibzkpt`,
    `procar`, `xdatcar`, `chgcar`, `wavecar`, `report`,
  ]

  const IMAGE_EXTS = [`.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.svg`, `.webp`, `.ico`, `.tiff`, `.tif`]
  const PDF_EXTS = [`.pdf`]
  const SPREADSHEET_EXTS = [`.csv`, `.tsv`]
  const EXCEL_EXTS = [`.xlsx`, `.xls`, `.xlsm`, `.xlsb`, `.ods`]
  const MARKDOWN_EXTS = [`.md`, `.rst`]

  function is_image(name: string): boolean {
    return IMAGE_EXTS.some((ext) => name.toLowerCase().endsWith(ext))
  }

  function is_pdf(name: string): boolean {
    return PDF_EXTS.some((ext) => name.toLowerCase().endsWith(ext))
  }

  function is_spreadsheet(name: string): boolean {
    return SPREADSHEET_EXTS.some((ext) => name.toLowerCase().endsWith(ext))
  }

  function is_markdown(name: string): boolean {
    return MARKDOWN_EXTS.some((ext) => name.toLowerCase().endsWith(ext))
  }

  function is_excel(name: string): boolean {
    return EXCEL_EXTS.some((ext) => name.toLowerCase().endsWith(ext))
  }

  /** Whether this is a binary file that needs binary reading. */
  function is_binary_preview(name: string): boolean {
    return is_image(name) || is_pdf(name) || is_excel(name)
  }

  function is_text(name: string): boolean {
    const lower = name.toLowerCase()
    const base = lower.split(`/`).pop() || ``
    if (VASP_NAMES.includes(base)) return true
    // Files like shared.o12345.exp-4-06 (PBS/SLURM output)
    if (/\.\w+\d+/.test(base)) return true
    // Preview files are also text-editable
    if (is_spreadsheet(lower) || is_markdown(lower)) return true
    return TEXT_EXTS.some((ext) => lower.endsWith(ext))
  }

  /** Determine the primary action for a file click. */
  function get_file_action(name: string): `load` | `edit` | `preview` | `none` {
    if (is_loadable(name)) return `load`
    if (is_image(name) || is_pdf(name) || is_spreadsheet(name) || is_markdown(name) || is_excel(name)) return `preview`
    if (is_text(name)) return `edit`
    return `none`
  }

  // ====== Category detection ======

  const SYSTEM_DIRS = new Set([`Documents`, `Downloads`, `Desktop`, `Applications`, `Library`, `Public`])
  const MEDIA_DIRS = new Set([`Movies`, `Music`, `Pictures`, `Photos`, `Videos`])
  const CODE_EXTS = new Set([`.py`, `.js`, `.ts`, `.rs`, `.svelte`, `.jsx`, `.tsx`, `.go`, `.c`, `.cpp`, `.h`, `.hpp`, `.java`, `.rb`, `.sh`, `.bash`, `.zsh`, `.f90`, `.f`])
  const DOC_EXTS = new Set([`.pdf`, `.md`, `.txt`, `.docx`, `.doc`, `.rst`, `.tex`, `.bib`, `.csv`, `.log`, `.out`])

  type ItemCategory = `system-dir` | `media-dir` | `hidden` | `code-file` | `document-file` | `structure-file` | `default-dir` | `default-file`

  function get_item_category(name: string, is_dir: boolean): ItemCategory {
    if (name.startsWith(`.`)) return `hidden`
    if (is_dir) {
      if (SYSTEM_DIRS.has(name)) return `system-dir`
      if (MEDIA_DIRS.has(name)) return `media-dir`
      return `default-dir`
    }
    if (is_loadable(name)) return `structure-file`
    const dot_idx = name.lastIndexOf(`.`)
    if (dot_idx >= 0) {
      const ext = name.slice(dot_idx).toLowerCase()
      if (CODE_EXTS.has(ext)) return `code-file`
      if (DOC_EXTS.has(ext)) return `document-file`
    }
    return `default-file`
  }

  const CATEGORY_COLORS: Record<ItemCategory, string> = {
    'system-dir': `#6C9CFC`,
    'media-dir': `#A78BFA`,
    'hidden': `#6B6C75`,
    'code-file': `#4ADE80`,
    'document-file': `#F472B6`,
    'structure-file': `#34D399`,
    'default-dir': `#6C9CFC`,
    'default-file': `#8B8D98`,
  }

  function get_item_color(name: string, is_dir: boolean): string {
    return CATEGORY_COLORS[get_item_category(name, is_dir)]
  }

  // Extensions that might be trajectory/structure files (need content-based detection)
  const MAYBE_LOADABLE_EXTS = [`.out`, `.log`]

  function is_report_file(name: string): boolean {
    return name === `REPORT` || name.toLowerCase() === `report`
  }

  function handle_file_click(node: TreeNode) {
    // VASP REPORT file → slow-growth analysis
    if (is_report_file(node.file.name) && on_analyze_report) {
      on_analyze_report(node.file)
      return
    }
    const action = get_file_action(node.file.name)
    if (action === `load` && on_load_structure) {
      on_load_structure(node.file)
    } else if (action === `preview` && on_preview_file) {
      const name = node.file.name.toLowerCase()
      const preview_type = is_image(name) ? `image`
        : is_pdf(name) ? `pdf`
        : is_excel(name) ? `excel`
        : is_markdown(name) ? `markdown`
        : `csv`
      on_preview_file(node.file, preview_type)
    } else if (action === `edit`) {
      // For .out/.log files, try loading as structure/trajectory first (content-based detection)
      const lower = node.file.name.toLowerCase()
      if (on_load_structure && MAYBE_LOADABLE_EXTS.some((ext) => lower.endsWith(ext))) {
        on_load_structure(node.file)
      } else if (on_open_editor) {
        on_open_editor(node.file)
      }
    }
  }

  function format_size(bytes: number): string {
    if (bytes === 0) return ``
    const units = [`B`, `KB`, `MB`, `GB`]
    let idx = 0
    let size = bytes
    while (size >= 1024 && idx < units.length - 1) { size /= 1024; idx++ }
    return `${size.toFixed(idx > 0 ? 1 : 0)} ${units[idx]}`
  }

  // ====== Tree node state ======

  interface TreeNode {
    file: RemoteFile
    children: TreeNode[] | null  // null = not loaded yet
    expanded: boolean
    loading: boolean
  }

  let root_nodes = $state<TreeNode[]>([])
  let root_loading = $state(false)
  let root_error = $state<string | null>(null)
  let show_hidden = $state(false)

  function partition_nodes(nodes: TreeNode[]): { visible: TreeNode[], hidden: TreeNode[] } {
    const visible: TreeNode[] = []
    const hidden: TreeNode[] = []
    for (const node of nodes) {
      if (node.file.name.startsWith(`.`)) hidden.push(node)
      else visible.push(node)
    }
    return { visible, hidden }
  }
  let current_root = $state(untrack(() => root_path))
  let path_editing = $state(false)
  let path_input_value = $state(untrack(() => root_path))
  let path_input_el = $state<HTMLInputElement | null>(null)

  async function load_dir(path: string): Promise<RemoteFile[]> {
    try {
      const result = await listFiles(session_id, path)
      if (result.files) {
        root_error = null
        return result.files
      }
    } catch (e: any) {
      const msg = e?.message || String(e)
      console.error(`Failed to list ${path}:`, e)
      // Don't retry on session errors
      if (msg.includes(`not found`) || msg.includes(`expired`)) {
        root_error = t('sidebar.session_expired')
        return []
      }
      root_error = msg
    }
    return []
  }

  function files_to_nodes(files: RemoteFile[]): TreeNode[] {
    // Sort: dirs first, then by name
    const sorted = [...files].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return sorted.map((f) => ({
      file: f,
      children: null,
      expanded: false,
      loading: false,
    }))
  }

  // Monotonic counter to discard stale load_root results when CWD changes
  // faster than the backend can respond (race condition).
  let _load_root_seq = 0

  // Load root directory (does NOT fire on_navigate — caller is responsible)
  async function load_root(path: string) {
    const seq = ++_load_root_seq
    root_loading = true
    current_root = path
    _loaded_path = path
    const files = await load_dir(path)
    // Discard result if a newer load_root was triggered while we were waiting
    if (seq !== _load_root_seq) return
    root_nodes = files_to_nodes(files)
    root_loading = false
  }

  // Toggle a directory node
  async function toggle_dir(node: TreeNode) {
    if (!node.file.is_dir) return
    if (node.expanded) {
      node.expanded = false
      return
    }
    if (node.children === null) {
      node.loading = true
      const files = await load_dir(node.file.path)
      node.children = files_to_nodes(files)
      node.loading = false
    }
    node.expanded = true
  }

  // Navigate up (user-initiated)
  function go_up() {
    if (current_root === `~` || current_root === `/`) return
    const parts = current_root.split(`/`)
    parts.pop()
    const parent = parts.join(`/`) || `/`
    load_root(parent)
    on_navigate?.(parent)
  }

  // Navigate to path (user-initiated, e.g., from editable path bar)
  function navigate_user(path: string) {
    const trimmed = path.trim()
    if (!trimmed || trimmed === current_root) return
    load_root(trimmed)
    on_navigate?.(trimmed)
  }

  // Load when root_path prop changes (external navigation or initial load)
  let _loaded_path = $state<string | null>(null)
  $effect(() => {
    if (session_id && root_path !== _loaded_path) {
      _loaded_path = root_path
      load_root(root_path)
    }
  })

  // ====== Breadcrumb segments ======

  interface BreadcrumbSegment {
    label: string
    path: string
    is_home: boolean
  }

  let breadcrumb_segments = $derived.by((): BreadcrumbSegment[] => {
    const p = current_root
    if (!p) return []
    const segments: BreadcrumbSegment[] = []
    if (p.startsWith(`~`)) {
      segments.push({ label: `~`, path: `~`, is_home: true })
      const rest = p.slice(1).replace(/^\//, ``)
      if (rest) {
        const parts = rest.split(`/`)
        let acc = `~`
        for (const part of parts) {
          acc += `/${part}`
          segments.push({ label: part, path: acc, is_home: false })
        }
      }
    } else {
      segments.push({ label: `/`, path: `/`, is_home: true })
      const rest = p.replace(/^\//, ``)
      if (rest) {
        const parts = rest.split(`/`)
        let acc = ``
        for (const part of parts) {
          acc += `/${part}`
          segments.push({ label: part, path: acc, is_home: false })
        }
      }
    }
    return segments
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  class="file-tree"
  class:drop-active={drop_target_path === current_root}
  onclick={() => { merge_menu_path = null }}
  ondragover={(e) => handle_dragover(e, current_root)}
  ondragleave={handle_dragleave}
  ondrop={(e) => handle_drop(e, current_root)}
>
  <!-- Merge status banner -->
  {#if merge_status}
    <div class="merge-status" class:success={merge_status.type === `success`} class:error={merge_status.type === `error`}>
      {merge_status.message}
    </div>
  {/if}

  <!-- Path bar -->
  <div class="tree-path-bar">
    <button class="tree-nav-btn" onclick={go_up} title={t('sidebar.go_up')}>&#x2191;</button>
    {#if path_editing}
      <input
        class="tree-path-input"
        bind:this={path_input_el}
        bind:value={path_input_value}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            path_editing = false
            navigate_user(path_input_value)
          } else if (e.key === 'Escape') {
            path_editing = false
            path_input_value = current_root
          }
        }}
        onblur={() => {
          path_editing = false
          // Navigate if value changed
          if (path_input_value.trim() && path_input_value.trim() !== current_root) {
            navigate_user(path_input_value)
          }
        }}
      />
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
      <div
        class="breadcrumb-bar"
        onclick={() => {
          path_editing = true
          path_input_value = current_root
          requestAnimationFrame(() => path_input_el?.select())
        }}
        title={t('sidebar.click_to_edit_path')}
      >
        {#each breadcrumb_segments as seg, idx}
          {#if idx > 0}
            <span class="breadcrumb-sep"><Icon icon="ChevronRight" style="width: 10px; height: 10px; vertical-align: middle;" /></span>
          {/if}
          <button
            class="breadcrumb-segment"
            class:is-last={idx === breadcrumb_segments.length - 1}
            onclick={(e) => { e.stopPropagation(); if (seg.path !== current_root) { load_root(seg.path); on_navigate?.(seg.path) } }}
          >
            {#if seg.is_home}
              <Icon icon="Home" style="width: 12px; height: 12px; vertical-align: middle;" />
              <span class="breadcrumb-home-text">{current_root === `~` ? `~` : `/`}</span>
            {:else}
              {seg.label}
            {/if}
          </button>
        {/each}
      </div>
    {/if}
    <button
      class="tree-nav-btn"
      title={copy_feedback || t('sidebar.copy_path')}
      onclick={() => {
        navigator.clipboard.writeText(current_root).then(() => {
          copy_feedback = t('sidebar.copied_to_clipboard')
          if (copy_feedback_timer) clearTimeout(copy_feedback_timer)
          copy_feedback_timer = setTimeout(() => { copy_feedback = null }, 1500)
        }).catch(() => {}) // Clipboard API may be unavailable (non-HTTPS, iframe sandbox)
      }}
    >
      {#if copy_feedback}
        &#x2713;
      {:else}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align: middle;">
          <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      {/if}
    </button>
    <button class="tree-nav-btn" onclick={() => { _loaded_path = null; load_root(current_root) }} title={t('common.refresh')}>&#x21BB;</button>
    {#if on_mkdir}
      <button class="tree-nav-btn" onclick={start_new_folder_inline} title={t('sidebar.new_folder')}>&#x2795;</button>
    {/if}
  </div>

  {#if root_error}
    <div class="tree-error">{root_error}</div>
  {:else if root_loading}
    <div class="tree-loading">{t('common.loading')}</div>
  {:else}
    <!-- New folder inline input -->
    {#if new_folder_parent}
      <div class="new-folder-row">
        <input
          class="new-folder-input"
          bind:value={new_folder_name}
          onkeydown={(e) => {
            if (e.key === `Enter`) do_new_folder(new_folder_parent || current_root)
            if (e.key === `Escape`) { new_folder_parent = null; new_folder_name = `` }
          }}
          onblur={() => { new_folder_parent = null; new_folder_name = `` }}
          placeholder={t('sidebar.folder_name')}
        />
      </div>
    {/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="tree-nodes"
      class:drop-active={drop_target_path === current_root}
      ondragover={(e) => handle_dragover(e, current_root)}
      ondragleave={handle_dragleave}
      ondrop={(e) => handle_drop(e, current_root)}
    >
      {@render tree_children(root_nodes, 0)}
    </div>
  {/if}

  <!-- Clipboard indicator -->
  {#if clipboard}
    <div class="clipboard-indicator">
      <span class="clipboard-op">{clipboard.op === `copy` ? t('sidebar.copied') : t('common.cut')}:</span>
      <span class="clipboard-name">{clipboard.file.name}</span>
      <button class="clipboard-clear" onclick={() => clipboard = null} title={t('structure.clear_clipboard')}>&#x2715;</button>
    </div>
  {/if}
</div>

<!-- Context menu (rendered outside .file-tree to avoid overflow clipping) -->
{#if ctx_menu}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="ft-ctx-overlay" onclick={close_ctx_menu}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="ft-ctx-menu" style="left: {ctx_menu.x}px; top: {ctx_menu.y}px" onclick={(e) => e.stopPropagation()}>
      {#if ctx_menu.node.file.is_dir && on_mkdir}
        <button class="ft-ctx-item" onclick={() => { new_folder_parent = ctx_menu?.node.file.path ?? current_root; new_folder_name = t('sidebar.new_folder'); close_ctx_menu() }}>{t('sidebar.new_folder')}</button>
      {/if}
      {#if on_rename}
        <button class="ft-ctx-item" onclick={() => { renaming_node = ctx_menu?.node ?? null; rename_value = ctx_menu?.node.file.name ?? ``; close_ctx_menu() }}>{t('common.rename')}</button>
      {/if}
      {#if on_copy_file}
        <button class="ft-ctx-item" onclick={() => { if (ctx_menu) clipboard = { file: ctx_menu.node.file, op: `copy` }; close_ctx_menu() }}>{t('common.copy')}</button>
      {/if}
      {#if on_move_file}
        <button class="ft-ctx-item" onclick={() => { if (ctx_menu) clipboard = { file: ctx_menu.node.file, op: `cut` }; close_ctx_menu() }}>{t('common.cut')}</button>
      {/if}
      {#if clipboard && (on_copy_file || on_move_file)}
        <button class="ft-ctx-item" onclick={() => { do_paste(); close_ctx_menu() }}>{t('common.paste')}</button>
      {/if}
      {#if on_download}
        <button class="ft-ctx-item" onclick={() => { if (ctx_menu) on_download?.(ctx_menu.node.file); close_ctx_menu() }}>{t('common.download')}</button>
      {/if}
      {#if on_copy_path}
        <button class="ft-ctx-item" onclick={() => { if (ctx_menu) on_copy_path?.(ctx_menu.node.file); close_ctx_menu() }}>{t('sidebar.copy_path')}</button>
      {/if}
      {#if on_analyze_report && !ctx_menu.node.file.is_dir && is_report_file(ctx_menu.node.file.name)}
        <button class="ft-ctx-item" onclick={() => { if (ctx_menu) on_analyze_report?.(ctx_menu.node.file); close_ctx_menu() }}>{t('structure.slow_growth_post_processing')}</button>
      {/if}
      <hr class="ft-ctx-divider" />
      {#if on_delete}
        <button class="ft-ctx-item danger" onclick={() => { delete_confirm_file = ctx_menu?.node.file ?? null; close_ctx_menu() }}>{t('common.delete')}</button>
      {/if}
    </div>
  </div>
{/if}

<!-- Delete confirmation dialog -->
{#if delete_confirm_file}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="ft-ctx-overlay" onclick={() => delete_confirm_file = null}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="ft-delete-dialog" onclick={(e) => e.stopPropagation()}>
      <p>{t('app.delete_item_confirm', { name: delete_confirm_file.name })}</p>
      <p class="ft-delete-path">{delete_confirm_file.path}</p>
      <div class="ft-delete-actions">
        <button class="ft-delete-btn cancel" onclick={() => delete_confirm_file = null}>{t('common.cancel')}</button>
        <button class="ft-delete-btn confirm" disabled={op_loading} onclick={do_delete}>{op_loading ? t('app.deleting') : t('common.delete')}</button>
      </div>
    </div>
  </div>
{/if}

<!-- Rename dialog -->
{#if renaming_node}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="ft-ctx-overlay" onclick={() => renaming_node = null}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="ft-delete-dialog" onclick={(e) => e.stopPropagation()}>
      <p>{t('app.rename_item', { name: renaming_node.file.name })}</p>
      <input
        class="ft-rename-input"
        bind:value={rename_value}
        onkeydown={(e) => { if (e.key === `Enter`) do_rename(); if (e.key === `Escape`) renaming_node = null }}
      />
      <div class="ft-delete-actions">
        <button class="ft-delete-btn cancel" onclick={() => renaming_node = null}>{t('common.cancel')}</button>
        <button class="ft-delete-btn confirm" disabled={op_loading || !rename_value.trim()} onclick={do_rename}>{op_loading ? t('app.renaming') : t('common.rename')}</button>
      </div>
    </div>
  </div>
{/if}

{#snippet tree_node(node: TreeNode, depth: number)}
  {@const item_color = get_item_color(node.file.name, node.file.is_dir)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="tree-row"
    class:drop-target={node.file.is_dir && drop_target_path === node.file.path}
    style="padding-left: {8 + depth * 16}px"
    oncontextmenu={(e) => open_ctx_menu(e, node)}
    ondragover={node.file.is_dir ? (e) => handle_dragover(e, node.file.path) : undefined}
    ondragleave={node.file.is_dir ? handle_dragleave : undefined}
    ondrop={node.file.is_dir ? (e) => handle_drop(e, node.file.path) : undefined}
  >
    {#if node.file.is_dir}
      <button class="tree-item dir" onclick={() => toggle_dir(node)}>
        <span class="tree-icon-wrap" style="background: {item_color}1a;">
          {#if node.loading}
            <span class="tree-spinner"></span>
          {:else}
            <Icon icon={node.expanded ? `DirectoryOpen` : `Directory`} style="width: 14px; height: 14px; color: {item_color};" />
          {/if}
        </span>
        <span class="tree-name">{node.file.name}</span>
      </button>
      <span class="tree-chevron"><Icon icon="ChevronRight" style="width: 12px; height: 12px;" /></span>
      {#if merging_dir === node.file.name}
        <span class="merge-spinner" title={t('sidebar.merging_structures')}>{t('sidebar.merging')}</span>
      {:else if on_load_trajectory}
        <div class="merge-wrap">
          <button
            class="merge-btn"
            title={t('sidebar.merge_structures_as_trajectory')}
            onclick={(e) => { e.stopPropagation(); merge_menu_path = merge_menu_path === node.file.path ? null : node.file.path }}
          >{t('sidebar.merge')}</button>
          {#if merge_menu_path === node.file.path}
            <div class="merge-menu">
              {#each MERGE_PATTERNS as pat}
                <button
                  class="merge-menu-item"
                  onclick={(e) => { e.stopPropagation(); merge_menu_path = null; on_load_trajectory?.(node.file, pat) }}
                >
                  {pat}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if on_copy_path}
        <button class="tree-action-btn copy" onclick={(e) => { e.stopPropagation(); on_copy_path?.(node.file) }} title={t('sidebar.copy_path')}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
        </button>
      {/if}
    {:else}
      {@const action = get_file_action(node.file.name)}
      <button
        class="tree-item file"
        class:clickable={action !== `none`}
        class:is-loadable={action === `load`}
        class:is-editable={action === `edit`}
        class:is-preview={action === `preview`}
        onclick={() => handle_file_click(node)}
        title={action === `load` ? t('sidebar.click_to_load_structure') : action === `preview` ? t('sidebar.click_to_preview') : action === `edit` ? t('sidebar.click_to_edit') : node.file.name}
      >
        <span class="tree-icon-wrap" style="background: {item_color}1a;">
          <Icon icon="File" style="width: 14px; height: 14px; color: {item_color};" />
        </span>
        <span class="tree-name">{node.file.name}</span>
        <span class="tree-size">{format_size(node.file.size_bytes)}</span>
        {#if action === `load`}
          <span class="tree-badge load-badge" title={t('sidebar.loadable_structure')}>▶</span>
        {:else if action === `preview`}
          <span class="tree-badge preview-badge" title={t('sidebar.preview')}>&#x1F441;</span>
        {:else if action === `edit`}
          <span class="tree-badge edit-badge" title={t('sidebar.editable')}>&#x270E;</span>
        {/if}
      </button>
      <!-- Separate action buttons for alternative actions -->
      {#if action === `load` && on_open_editor && is_text(node.file.name)}
        <!-- Loadable file can also be edited as text -->
        <button class="tree-action-btn edit" onclick={(e) => { e.stopPropagation(); on_open_editor?.(node.file) }} title={t('structure.edit_as_text')}>
          &#x270E;
        </button>
      {/if}
      {#if action === `preview` && on_open_editor && is_text(node.file.name)}
        <button class="tree-action-btn edit" onclick={(e) => { e.stopPropagation(); on_open_editor?.(node.file) }} title={t('structure.edit_as_text')}>
          &#x270E;
        </button>
      {/if}
      {#if on_download}
        <button class="tree-action-btn download" onclick={(e) => { e.stopPropagation(); on_download?.(node.file) }} title={t('common.download')}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
      {/if}
      {#if on_copy_path}
        <button class="tree-action-btn copy" onclick={(e) => { e.stopPropagation(); on_copy_path?.(node.file) }} title={t('sidebar.copy_path')}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
        </button>
      {/if}
    {/if}
  </div>
  {#if node.file.is_dir && node.expanded && node.children}
    {#if node.children.length === 0}
      <div class="tree-row tree-empty" style="padding-left: {8 + (depth + 1) * 16}px">
        <span class="tree-name dim">({t('common.empty')})</span>
      </div>
    {:else}
      {@render tree_children(node.children, depth + 1)}
    {/if}
  {/if}
{/snippet}

{#snippet tree_children(nodes: TreeNode[], depth: number)}
  {@const { visible, hidden } = partition_nodes(nodes)}
  {#each visible as node}
    {@render tree_node(node, depth)}
  {/each}
  {#if hidden.length > 0}
    <button
      class="hidden-toggle"
      style="padding-left: {8 + depth * 16}px"
      aria-expanded={show_hidden}
      onclick={() => { show_hidden = !show_hidden }}
    >
      <span class="hidden-toggle-chevron" class:expanded={show_hidden}>
        <Icon icon="ChevronRight" style="width: 12px; height: 12px;" />
      </span>
      {t('sidebar.hidden_items', { n: hidden.length })}
    </button>
    {#if show_hidden}
      <div transition:slide={{ duration: 200 }}>
        {#each hidden as node}
          {@render tree_node(node, depth)}
        {/each}
      </div>
    {/if}
  {/if}
{/snippet}

<style>
  .file-tree {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .file-tree.drop-active {
    background: rgba(59, 130, 246, 0.06);
  }
  .tree-path-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: light-dark(rgba(0,0,0,0.06), rgba(0,0,0,0.2));
    border-bottom: 1px solid light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.06));
    flex-shrink: 0;
  }
  .breadcrumb-bar {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
    min-width: 0;
    cursor: text;
  }
  .breadcrumb-bar::-webkit-scrollbar { display: none; }
  .breadcrumb-home-text {
    font-size: 0.72em;
    font-family: monospace;
    margin-left: 2px;
    color: var(--text-color-muted);
  }
  .breadcrumb-segment {
    background: none;
    border: none;
    color: var(--text-color-muted);
    font-size: 0.72em;
    font-family: monospace;
    padding: 2px 5px;
    border-radius: 3px;
    cursor: pointer;
    white-space: nowrap;
    line-height: 1.4;
    transition: color 0.12s, background-color 0.12s;
  }
  .breadcrumb-segment:hover {
    color: #6C9CFC;
    background: rgba(108, 156, 252, 0.1);
  }
  .breadcrumb-segment.is-last {
    color: var(--text-color);
    font-weight: 500;
    cursor: default;
  }
  .breadcrumb-segment.is-last:hover {
    color: var(--text-color);
    background: none;
  }
  .breadcrumb-sep {
    color: var(--text-color-dim);
    opacity: 0.5;
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }
  .tree-path-input {
    flex: 1;
    font-size: 0.72em;
    color: var(--text-color);
    font-family: monospace;
    background: light-dark(rgba(0,0,0,0.08), rgba(0,0,0,0.3));
    border: 1px solid color-mix(in srgb, var(--accent-color, #3b82f6) 40%, transparent);
    border-radius: 2px;
    padding: 1px 3px;
    outline: none;
    min-width: 0;
  }
  .tree-nav-btn {
    background: none;
    border: 1px solid var(--border-color, light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.12)));
    color: var(--text-color-muted);
    border-radius: 3px;
    cursor: pointer;
    padding: 1px 5px;
    font-size: 0.75em;
    line-height: 1.4;
  }
  .tree-nav-btn:hover {
    background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1)));
    color: var(--text-color);
  }
  .tree-nodes {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .tree-nodes.drop-active {
    background: rgba(59, 130, 246, 0.06);
    outline: 1.5px dashed rgba(59, 130, 246, 0.4);
    outline-offset: -2px;
  }
  .tree-loading {
    padding: 12px;
    color: var(--text-color-muted);
    font-size: 0.8em;
  }
  .tree-error {
    padding: 12px;
    color: var(--error-color);
    font-size: 0.78em;
  }
  .tree-row {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 6px;
    min-height: 36px;
    border-radius: 4px;
    margin: 0 4px;
    transition: background 0.12s ease;
  }
  .tree-row:hover {
    background: rgba(255, 255, 255, 0.04);
  }
  .tree-row.drop-target {
    background: rgba(59, 130, 246, 0.15);
    outline: 1.5px dashed rgba(59, 130, 246, 0.5);
    outline-offset: -1px;
  }
  .tree-row:active {
    background: rgba(255, 255, 255, 0.07);
    transition: background 0.05s;
  }
  .tree-item {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    background: none;
    border: none;
    color: inherit;
    padding: 0;
    font: inherit;
    text-align: left;
  }
  .tree-item.dir {
    cursor: pointer;
  }
  .tree-item.dir:hover .tree-name {
    color: var(--accent-color);
  }
  .tree-item.file {
    cursor: default;
  }
  .tree-item.file.clickable {
    cursor: pointer;
  }
  .tree-item.file.clickable:hover .tree-name {
    text-decoration: underline;
  }
  .tree-item.file.is-loadable:hover .tree-name {
    color: var(--success-color);
  }
  .tree-item.file.is-editable:hover .tree-name {
    color: var(--accent-color);
  }
  .tree-item.file.is-preview:hover .tree-name {
    color: #da77f2;
  }
  .tree-icon-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    flex-shrink: 0;
    transition: filter 0.15s ease;
  }
  .tree-row:hover .tree-icon-wrap {
    filter: brightness(1.3);
  }
  .tree-chevron {
    display: flex;
    align-items: center;
    color: var(--text-color-dim);
    opacity: 0;
    transform: translateX(-4px);
    transition: opacity 0.15s ease, transform 0.15s ease;
    flex-shrink: 0;
    margin-left: auto;
  }
  .tree-row:hover .tree-chevron {
    opacity: 0.6;
    transform: translateX(0);
  }
  .tree-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255,255,255,0.15);
    border-top-color: var(--accent-color, #6C9CFC);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .tree-name {
    font-size: 0.8em;
    color: var(--text-color-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color 0.1s;
  }
  .tree-name.dim {
    color: var(--text-color-dim);
    font-style: italic;
  }
  .tree-size {
    font-size: 0.65em;
    color: var(--text-color-dim);
    white-space: nowrap;
    flex-shrink: 0;
    margin-left: auto;
    padding-left: 6px;
  }
  /* Always-visible badge indicating the file type action */
  .tree-badge {
    flex-shrink: 0;
    font-size: 0.65em;
    padding: 0 3px;
    border-radius: 2px;
    line-height: 1.4;
    margin-left: 2px;
  }
  .load-badge {
    color: var(--success-color);
  }
  .edit-badge {
    color: var(--accent-color);
  }
  .preview-badge {
    color: #da77f2;
  }
  /* Alternative action buttons (show on hover) */
  .tree-action-btn {
    background: var(--surface-bg-hover, light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.06)));
    border: 1px solid var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1)));
    border-radius: 3px;
    cursor: pointer;
    padding: 0 4px;
    font-size: 0.7em;
    line-height: 1.5;
    color: var(--text-color-muted);
    opacity: 0;
    transition: opacity 0.1s;
  }
  .tree-row:hover .tree-action-btn {
    opacity: 1;
  }
  .tree-action-btn:hover {
    background: var(--border-color);
    color: var(--text-color);
  }
  .tree-action-btn.edit { color: var(--accent-color); }
  .tree-action-btn.download { color: var(--success-color, #34d399); }
  .tree-action-btn.copy { color: var(--text-color-muted); }
  .tree-action-btn svg { vertical-align: middle; }
  /* Merge button + dropdown */
  .merge-wrap {
    position: relative;
    flex-shrink: 0;
  }
  .merge-btn {
    background: color-mix(in srgb, light-dark(#9333ea, #da77f2) 10%, transparent);
    border: 1px solid color-mix(in srgb, light-dark(#9333ea, #da77f2) 25%, transparent);
    border-radius: 3px;
    cursor: pointer;
    padding: 0 6px;
    font-size: 0.65em;
    line-height: 1.6;
    color: light-dark(#9333ea, #da77f2);
    opacity: 0;
    transition: opacity 0.15s, background 0.1s;
  }
  .tree-row:hover .merge-btn {
    opacity: 1;
  }
  .merge-btn:hover {
    background: color-mix(in srgb, light-dark(#9333ea, #da77f2) 20%, transparent);
    color: light-dark(#a855f7, #e599f7);
  }
  .merge-menu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 50;
    background: var(--surface-bg);
    border: 1px solid var(--border-color, light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.12)));
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    padding: 2px 0;
    margin-top: 2px;
    min-width: 90px;
  }
  .merge-menu-item {
    display: block;
    width: 100%;
    padding: 4px 10px;
    border: none;
    background: transparent;
    color: var(--text-color);
    font-size: 0.72em;
    cursor: pointer;
    text-align: left;
  }
  .merge-menu-item:hover {
    background: color-mix(in srgb, light-dark(#9333ea, #da77f2) 15%, transparent);
    color: light-dark(#a855f7, #e599f7);
  }
  .merge-spinner {
    font-size: 0.65em;
    color: light-dark(#9333ea, #da77f2);
    animation: pulse 1.2s infinite;
    flex-shrink: 0;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  /* Merge status banner */
  .merge-status {
    padding: 4px 8px;
    font-size: 0.72em;
    flex-shrink: 0;
  }
  .merge-status.success {
    background: color-mix(in srgb, var(--success-color) 12%, transparent);
    color: var(--success-color);
    border-bottom: 1px solid color-mix(in srgb, var(--success-color) 20%, transparent);
  }
  .merge-status.error {
    background: color-mix(in srgb, var(--error-color) 12%, transparent);
    color: var(--error-color);
    border-bottom: 1px solid color-mix(in srgb, var(--error-color) 20%, transparent);
  }
  .tree-empty {
    min-height: 20px;
  }
  /* Hidden files toggle */
  .hidden-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    width: calc(100% - 8px);
    margin: 2px 4px;
    padding: 6px 8px;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--text-color-muted);
    font-size: 0.72em;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .hidden-toggle:hover {
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-color);
  }
  .hidden-toggle:active {
    background: rgba(255, 255, 255, 0.07);
  }
  .hidden-toggle-chevron {
    display: flex;
    align-items: center;
    transition: transform 0.2s ease;
  }
  .hidden-toggle-chevron.expanded {
    transform: rotate(90deg);
  }

  /* New folder inline input */
  .new-folder-row {
    padding: 2px 8px;
  }
  .new-folder-input {
    width: 100%;
    padding: 3px 6px;
    font-size: 12px;
    background: var(--input-bg, rgba(0, 0, 0, 0.2));
    border: 1px solid var(--accent, #6366f1);
    border-radius: 4px;
    color: var(--text-color, #e5e7eb);
    outline: none;
  }

  /* Clipboard indicator */
  .clipboard-indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    font-size: 11px;
    background: rgba(99, 102, 241, 0.15);
    border-top: 1px solid rgba(99, 102, 241, 0.3);
    color: var(--text-color-muted, #9ca3af);
  }
  .clipboard-op { font-weight: 600; color: #818cf8; }
  .clipboard-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .clipboard-clear {
    background: none; border: none; color: var(--text-color-muted); cursor: pointer; padding: 0; font-size: 10px;
  }

  /* Context menu */
  .ft-ctx-overlay {
    position: fixed; inset: 0; z-index: 100000060;
  }
  .ft-ctx-menu {
    position: fixed;
    background: var(--dialog-bg, #1c1c2e);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    border-radius: 8px;
    padding: 4px 0;
    min-width: 140px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 100000061;
  }
  .ft-ctx-item {
    display: block;
    width: 100%;
    padding: 5px 12px;
    font-size: 12px;
    color: var(--text-color, #e5e7eb);
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
  }
  .ft-ctx-item:hover {
    background: rgba(99, 102, 241, 0.15);
  }
  .ft-ctx-item.danger {
    color: #ef4444;
  }
  .ft-ctx-item.danger:hover {
    background: rgba(239, 68, 68, 0.15);
  }
  .ft-ctx-divider {
    margin: 3px 0;
    border: none;
    border-top: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
  }

  /* Delete / Rename dialog */
  .ft-delete-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: var(--dialog-bg, #1c1c2e);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    border-radius: 10px;
    padding: 16px 20px;
    min-width: 280px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
    z-index: 100000062;
  }
  .ft-delete-dialog p {
    margin: 0 0 8px;
    font-size: 13px;
    color: var(--text-color, #e5e7eb);
  }
  .ft-delete-path {
    font-size: 11px;
    color: var(--text-color-muted, #6b7280);
    word-break: break-all;
    font-family: monospace;
  }
  .ft-delete-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  .ft-delete-btn {
    padding: 5px 14px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  }
  .ft-delete-btn.cancel {
    background: rgba(128, 128, 128, 0.1);
    color: var(--text-color, #e5e7eb);
  }
  .ft-delete-btn.confirm {
    background: rgba(239, 68, 68, 0.8);
    border-color: rgba(239, 68, 68, 0.6);
    color: white;
  }
  .ft-delete-btn.confirm:hover { background: rgba(239, 68, 68, 0.9); }
  .ft-delete-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .ft-rename-input {
    width: 100%;
    padding: 5px 8px;
    font-size: 13px;
    background: var(--input-bg, rgba(0, 0, 0, 0.2));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
    border-radius: 6px;
    color: var(--text-color, #e5e7eb);
    outline: none;
    margin-bottom: 4px;
  }
  .ft-rename-input:focus { border-color: var(--accent, #6366f1); }
</style>
