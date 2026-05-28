<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { PymatgenStructure } from '$lib'
  import type { V2Task } from '$lib/api/workflow-v2'
  import {
    get_v2_task,
    get_v2_task_result,
    confirm_engine_task,
    update_engine_task_params,
    get_engine_task_file_content,
    put_engine_task_file_content,
  } from '$lib/api/workflow-v2'
  import { pending_open_structure } from './workflow-state.svelte'
  import StructureEditModal from './components/StructureEditModal.svelte'
  import { NODE_DEFINITIONS } from './node-defs'
  import type { NodeDefinition, ParamDef } from './workflow-types'
  import { parse_xyz, parse_poscar } from '$lib/structure/parse'

  load_i18n_module(`workflow`)

  // ── Eagerly load StructurePreview (avoids async rendering issues with Threlte Canvas) ──
  let StructurePreviewComponent = $state<typeof import('$lib/structure/StructurePreview.svelte').default | null>(null)
  import('$lib/structure/StructurePreview.svelte').then(m => { StructurePreviewComponent = m.default })

  // ── Module-level structure cache (survives remounts) ──
  const _struct_cache = new Map<string, { input: PymatgenStructure | null; output: PymatgenStructure | null }>()

  // ── Props ──
  interface Props {
    task_id: string | null
    workflow_id: string
    onclose?: () => void
    onrefresh?: () => void
  }
  let { task_id, workflow_id, onclose, onrefresh }: Props = $props()

  // ── State ──
  let task = $state<V2Task | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let active_tab = $state<'structure' | 'parameters' | 'monitor'>('structure')

  // Structure state
  let input_structure = $state<PymatgenStructure | null>(null)
  let output_structure = $state<PymatgenStructure | null>(null)
  let preview_structure = $derived(output_structure ?? input_structure)

  // Parameters state
  let params = $state<Record<string, unknown>>({})
  let params_saving = $state(false)
  let params_error = $state<string | null>(null)

  // Confirm state
  let confirming = $state(false)

  // ── Derived helpers ──
  let task_label = $derived(task?.name ?? task?.task_type ?? t(`workflow.task_structure`))
  let task_type = $derived(task?.task_type ?? '')
  let is_editable = $derived(task ? ['WAITING', 'READY', 'PENDING_REVIEW'].includes(task.status) : false)
  let node_definition = $derived<NodeDefinition | undefined>(NODE_DEFINITIONS[task_type])

  // --- Full Structure Editor Modal ---
  let show_structure_modal = $state(false)
  let modal_structure = $state.raw<PymatgenStructure | null>(null)
  let modal_label = $state('')
  let modal_readonly = $state(false)
  let modal_bulk = $state.raw<PymatgenStructure | null>(null)
  let modal_is_trajectory = $state(false)
  let modal_trajectory = $state.raw<any>(undefined)
  let modal_initial_generated = $state.raw<any>(undefined)
  let modal_scene_props = $state<Record<string, unknown> | undefined>(undefined)
  let modal_vibration = $state<any>(null)
  let modal_initial_panel = $state<'hpc' | 'chat' | 'terminal' | 'doping' | 'slab' | 'adsorbate' | undefined>(undefined)
  let modal_adsorption_sites = $state<any[]>([])

  let StructureEditorComponent = $state<any>(null)
  let TrajectoryEditorComponent = $state<any>(null)

  // --- File Editor (Monaco) ---
  let show_file_editor = $state(false)
  let file_editor_path = $state('')
  let file_editor_content = $state('')
  let file_editor_saving = $state(false)

  // ── Status colors ──
  const STATUS_COLORS: Record<string, string> = {
    COMPLETED: '#22c55e',
    RUNNING: '#eab308',
    FAILED: '#ef4444',
    PENDING_REVIEW: '#f59e0b',
    WAITING: '#475569',
    READY: '#3b82f6',
    CANCELLED: '#6b7280',
  }

  function get_status_color(status: string): string {
    return STATUS_COLORS[status] ?? '#6b7280'
  }

  // ── Helper: parse param value from string ──
  function parse_param(value: string): unknown {
    const trimmed = value.trim()
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (trimmed === 'null') return null
    if (trimmed === '') return ''
    // Try number
    const num = Number(trimmed)
    if (!isNaN(num) && trimmed !== '') return num
    // Try JSON
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return JSON.parse(trimmed) } catch { /* fall through */ }
    }
    return trimmed
  }

  // ── Helper: format lattice dimensions ──
  function format_lattice(structure: PymatgenStructure): string {
    const lat = structure?.lattice
    if (!lat) return ''
    const a = lat.a ?? Math.sqrt(lat.matrix[0].reduce((s: number, v: number) => s + v * v, 0))
    const b = lat.b ?? Math.sqrt(lat.matrix[1].reduce((s: number, v: number) => s + v * v, 0))
    const c = lat.c ?? Math.sqrt(lat.matrix[2].reduce((s: number, v: number) => s + v * v, 0))
    return `${a.toFixed(2)}\u00d7${b.toFixed(2)}\u00d7${c.toFixed(2)} \u00c5`
  }

  // ── Keys to exclude from parameter editing ──
  const HIDDEN_PARAM_KEYS = new Set(['structure', 'structure_json', 'input_structure', 'output_structure'])

  // ── Parse structure from JSON string safely + normalize lattice ──
  function try_parse_structure(raw: unknown): PymatgenStructure | null {
    if (!raw) return null
    // Object input: must already be in pymatgen shape
    if (typeof raw !== 'string') {
      if (raw && typeof raw === 'object' && 'sites' in (raw as object)) {
        normalize_structure(raw)
        return raw as PymatgenStructure
      }
      return null
    }
    const trimmed = raw.trim()
    if (!trimmed) return null
    // pymatgen-serialized JSON (e.g. {"@module": ..., "sites": [...]})
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && 'sites' in parsed) {
          normalize_structure(parsed)
          return parsed as PymatgenStructure
        }
      } catch { /* fall through to text-format parsers */ }
    }
    // Plain-text formats produced by V2 engine output collectors:
    //   ORCA NEB-TS → XYZ (first line is an atom count integer)
    //   VASP/MLP    → POSCAR (line 2 is a numeric scale factor)
    const first_line = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? ''
    const is_xyz = /^\d+$/.test(first_line)
    const parsed = is_xyz ? parse_xyz(trimmed) : parse_poscar(trimmed)
    if (parsed && parsed.sites?.length) {
      // ParsedStructure has optional lattice; PymatgenStructure requires it
      // but downstream renderers handle lattice-less molecules conditionally.
      return parsed as unknown as PymatgenStructure
    }
    return null
  }

  /** Fill in missing lattice params (a/b/c/alpha/beta/gamma) and site xyz from matrix + abc */
  function normalize_structure(s: any) {
    if (!s?.lattice?.matrix) return
    const m = s.lattice.matrix
    const va = m[0], vb = m[1], vc = m[2]
    const norm = (v: number[]) => Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2])
    const dot = (a: number[], b: number[]) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2]
    const a = norm(va), b = norm(vb), c = norm(vc)
    if (!s.lattice.a) s.lattice.a = a
    if (!s.lattice.b) s.lattice.b = b
    if (!s.lattice.c) s.lattice.c = c
    if (!s.lattice.alpha) s.lattice.alpha = Math.acos(dot(vb,vc)/(b*c)) * 180/Math.PI
    if (!s.lattice.beta) s.lattice.beta = Math.acos(dot(va,vc)/(a*c)) * 180/Math.PI
    if (!s.lattice.gamma) s.lattice.gamma = Math.acos(dot(va,vb)/(a*b)) * 180/Math.PI
    // Fill in xyz from abc if missing
    for (const site of s.sites ?? []) {
      if (!site.xyz && site.abc) {
        const [fa, fb, fc] = site.abc
        site.xyz = [
          fa*m[0][0] + fb*m[1][0] + fc*m[2][0],
          fa*m[0][1] + fb*m[1][1] + fc*m[2][1],
          fa*m[0][2] + fb*m[1][2] + fc*m[2][2],
        ]
      }
    }
  }

  // ── Load task data ──
  async function load_task(tid: string) {
    loading = true
    error = null
    try {
      // Check cache first
      const cached = _struct_cache.get(tid)
      if (cached) {
        input_structure = cached.input
        output_structure = cached.output
      }

      const { task: t } = await get_v2_task(tid)
      task = t

      // Parse params
      try {
        params = typeof t.params_json === 'string' ? JSON.parse(t.params_json) : (t.params_json as unknown as Record<string, unknown>) ?? {}
      } catch {
        params = {}
      }

      // Parse input/output structures. Re-fetch on cache miss OR when the cached
      // entry has no output_structure but the task is now COMPLETED — this
      // recovers from earlier loads where the result hadn't arrived yet or the
      // parser couldn't handle the format (pre-XYZ-support cache entries).
      const needs_refetch = !cached || (cached.output == null && t.status === 'COMPLETED')
      if (needs_refetch) {
        const inp = try_parse_structure(params.structure) ?? try_parse_structure(params.structure_json)
        input_structure = inp

        // Try to get result structure for completed tasks
        let outp: PymatgenStructure | null = null
        if (t.status === 'COMPLETED') {
          try {
            const result = await get_v2_task_result(tid)
            outp = try_parse_structure(result.structure_json) ?? try_parse_structure(result.structure)
          } catch { /* no result yet */ }
        }
        output_structure = outp

        // Save to cache
        _struct_cache.set(tid, { input: input_structure, output: output_structure })
      }
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  // ── Reactively load when task_id changes ──
  $effect(() => {
    if (task_id) {
      load_task(task_id)
    } else {
      task = null
      params = {}
      input_structure = null
      output_structure = null
    }
  })

  // ── Save a single param on blur ──
  async function save_param(key: string, raw_value: string) {
    if (!task_id || !task) return
    const parsed = parse_param(raw_value)
    if (params[key] === parsed) return

    params_saving = true
    params_error = null
    try {
      const updated = { ...params, [key]: parsed }
      await update_engine_task_params(task_id, updated)
      params[key] = parsed
    } catch (e: unknown) {
      params_error = e instanceof Error ? e.message : String(e)
    } finally {
      params_saving = false
    }
  }

  // ── Confirm task ──
  async function handle_confirm() {
    if (!task_id || confirming) return
    confirming = true
    try {
      await confirm_engine_task(task_id)
      // Reload task to get updated status
      await load_task(task_id)
      onrefresh?.()
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      confirming = false
    }
  }

  // ── Open structure in full editor ──
  async function open_full_editor() {
    if (!preview_structure) return

    // Lazy-load Structure.svelte
    if (!StructureEditorComponent) {
      const mod = await import('$lib/structure/Structure.svelte')
      StructureEditorComponent = mod.default
    }

    modal_label = task_label
    modal_readonly = !is_editable
    modal_vibration = null
    modal_adsorption_sites = []
    modal_is_trajectory = false
    modal_trajectory = undefined
    modal_initial_generated = undefined
    modal_scene_props = undefined

    // Task-specific initial panel — auto-open the right Build Tool
    if (task_type === 'slab_gen') {
      // For slab_gen: open with BULK structure so user can re-cut
      modal_structure = input_structure
        ? JSON.parse(JSON.stringify(input_structure))
        : JSON.parse(JSON.stringify(preview_structure))
      modal_bulk = modal_structure
      modal_initial_panel = 'slab'
    } else if (task_type === 'adsorbate_place') {
      // For adsorbate: open with slab structure for placement
      modal_structure = JSON.parse(JSON.stringify(preview_structure))
      modal_bulk = input_structure ? JSON.parse(JSON.stringify(input_structure)) : null
      modal_initial_panel = 'adsorbate'
    } else {
      // Default: open with current structure
      modal_structure = JSON.parse(JSON.stringify(preview_structure))
      modal_bulk = input_structure ? JSON.parse(JSON.stringify(input_structure)) : null
      modal_initial_panel = undefined
    }

    show_structure_modal = true
  }

  // ── Save structure back to engine task params ──
  async function handle_structure_change(struct: PymatgenStructure) {
    if (!task_id || !task) return
    try {
      const updated = { ...params, structure: struct }
      await update_engine_task_params(task_id, updated)
      params.structure = struct
      input_structure = struct
      // Update cache
      _struct_cache.set(task_id, { input: struct, output: output_structure })
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  // ── File editor functions ──
  async function open_file_editor(filename: string) {
    if (!task_id) return
    try {
      const data = await get_engine_task_file_content(task_id, filename)
      file_editor_path = filename
      file_editor_content = data.content
      show_file_editor = true
    } catch (e: any) {
      error = `Failed to load file: ${e.message}`
    }
  }

  async function save_file_content() {
    if (!task_id || !file_editor_path) return
    file_editor_saving = true
    try {
      await put_engine_task_file_content(task_id, file_editor_path, file_editor_content)
      show_file_editor = false
    } catch (e: any) {
      error = `Failed to save file: ${e.message}`
    } finally {
      file_editor_saving = false
    }
  }

  // ── Filtered params for display ──
  let display_params = $derived.by(() => {
    const entries: [string, unknown][] = []
    for (const [k, v] of Object.entries(params)) {
      if (!HIDDEN_PARAM_KEYS.has(k)) {
        entries.push([k, v])
      }
    }
    return entries
  })

  // Escape key closes the file overlay
  $effect(() => {
    if (!show_file_editor) return
    function on_keydown(e: KeyboardEvent) {
      if (e.key === 'Escape') show_file_editor = false
    }
    window.addEventListener('keydown', on_keydown)
    return () => window.removeEventListener('keydown', on_keydown)
  })
</script>

<div class="ete-root">
  {#if !task_id}
    <div class="ete-empty">
      <span class="ete-empty-icon">&#x1F4CB;</span>
      <span>{t(`workflow.select_task_details`)}</span>
    </div>
  {:else if loading && !task}
    <div class="ete-loading">{t(`workflow.loading_task`)}</div>
  {:else if error && !task}
    <div class="ete-error">
      <span class="ete-error-icon">&#x26A0;</span>
      <span>{error}</span>
      <button class="ete-retry-btn" onclick={() => task_id && load_task(task_id)}>{t(`workflow.retry`)}</button>
    </div>
  {:else if task}
    <!-- Header -->
    <div class="ete-header">
      <div class="ete-header-info">
        <span class="ete-title">{task.name ?? task.task_type}</span>
        <span class="ete-badge" style:background={get_status_color(task.status)}>{task.status}</span>
      </div>
      {#if onclose}
        <button class="ete-close-btn" onclick={onclose} title={t(`workflow.close`)}>&times;</button>
      {/if}
    </div>

    <!-- Task type subtitle -->
    {#if task.name && task.task_type}
      <div class="ete-subtitle">{task.task_type}{task.software ? ` \u00b7 ${task.software}` : ''}</div>
    {/if}

    <!-- PENDING_REVIEW banner -->
    {#if task.status === 'PENDING_REVIEW'}
      <div class="ete-review-banner">
        <span>{t(`workflow.task_awaiting_review`)}</span>
        <button class="ete-confirm-btn" onclick={handle_confirm} disabled={confirming}>
          {confirming ? t(`workflow.confirming`) : t(`workflow.confirm_continue`)}
        </button>
      </div>
    {/if}

    <!-- Error banner -->
    {#if task.error_message}
      <div class="ete-error-banner">
        <strong>{t(`workflow.error_label`)}</strong> {task.error_message}
      </div>
    {/if}

    <!-- Tab bar -->
    <div class="ete-tabs">
      <button
        class="ete-tab"
        class:ete-tab-active={active_tab === 'structure'}
        onclick={() => active_tab = 'structure'}
      >{t(`workflow.structure`)}</button>
      <button
        class="ete-tab"
        class:ete-tab-active={active_tab === 'monitor'}
        onclick={() => active_tab = 'monitor'}
      >{t(`workflow.monitor`)}</button>
    </div>

    <!-- Tab content -->
    <div class="ete-content">
      <!-- Structure tab -->
      {#if active_tab === 'structure'}
        <div class="ete-structure-tab">
          <div class="ete-preview-viewport">
            {#if preview_structure && StructurePreviewComponent}
              <StructurePreviewComponent structure={preview_structure} />
            {:else if preview_structure}
              <div class="ete-preview-empty">
                <span>{t(`workflow.loading_preview`)}</span>
              </div>
            {:else}
              <div class="ete-preview-empty">
                <span>{t(`workflow.no_structure_available`)}</span>
              </div>
            {/if}
          </div>

          {#if preview_structure}
            <div class="ete-structure-actions">
              <button class="ete-action-btn primary" onclick={open_full_editor}>
                {t(`workflow.open_full_editor`)}
              </button>
              <button class="ete-action-btn" onclick={() => {
                if (preview_structure) {
                  pending_open_structure.structure = preview_structure
                  pending_open_structure.label = task_label
                  pending_open_structure.seq++
                }
              }}>
                {t(`workflow.new_tab`)}
              </button>
            </div>
            <div class="ete-structure-info">
              <span>
                {output_structure ? t(`workflow.output`) : t(`workflow.input`)} &middot;
                {t(`workflow.atom_count_plain`, { n: preview_structure.sites?.length ?? 0 })}
                {#if preview_structure.lattice}
                  &middot; {format_lattice(preview_structure)}
                {/if}
              </span>
            </div>
          {/if}

          <!-- Task-specific embedded tool panes -->
          {#if task_type === 'slab_gen' && is_editable && input_structure}
            <div class="ete-tool-section">
              <div class="ete-tool-header">{t(`workflow.slab_cutter`)}</div>
              {#await import('$lib/structure/MillerSlabCutterPane.svelte') then mod}
                <mod.default
                  structure={preview_structure ?? undefined}
                  bulk_structure={input_structure}
                  pane_open={true}
                  embedded={true}
                  on_structure_change={(s) => handle_structure_change(s)}
                />
              {/await}
            </div>
          {/if}

          {#if task_type === 'adsorbate_place' && is_editable && preview_structure}
            <div class="ete-tool-section">
              <div class="ete-tool-header">{t(`workflow.adsorbate_placement`)}</div>
              {#await import('$lib/structure/AdsorbatePlacementPane.svelte') then mod}
                <mod.default
                  structure={preview_structure ?? undefined}
                  pane_open={true}
                  embedded={true}
                  on_structure_change={(s) => handle_structure_change(s as PymatgenStructure)}
                />
              {/await}
            </div>
          {/if}

          <!-- Parameters section (inline below structure) -->
          <div class="ete-params-inline">
            {#if params_error}
              <div class="ete-params-error">{params_error}</div>
            {/if}
            {#if params_saving}
              <div class="ete-params-saving">{t(`workflow.saving`)}</div>
            {/if}

            {#if node_definition?.param_schema?.length}
              {@const schema = node_definition.param_schema}
              {@const groups = [...new Set(schema.map(p => p.group ?? ''))]}
              {#each groups as group}
                {@const group_params = schema.filter(p => (p.group ?? '') === group && (params[p.key] !== undefined || is_editable))}
                {#if group && group_params.length > 0}
                  <div class="ete-param-group">{group}</div>
                {/if}
                {#each group_params as param}
                  {@const show_cond = param.show_if}
                  {@const show_conds = !show_cond ? [] : Array.isArray(show_cond) ? show_cond : [show_cond]}
                  {#if !show_cond || show_conds.every(c => (c.values ?? []).includes(String(params[c.key] ?? '')))}
                    <div class="ete-param-row" title={param.help ?? ''}>
                      <label class="ete-param-label">{param.label}</label>
                      {#if param.type === 'boolean'}
                        {@const bool_val = params[param.key] !== undefined ? !!params[param.key] : !!param.default}
                        <button class="ete-toggle-btn" class:on={bool_val}
                          disabled={!is_editable}
                          onclick={() => { save_param(param.key, String(!bool_val)) }}>
                          {bool_val ? t(`workflow.on`) : t(`workflow.off`)}
                        </button>
                      {:else if param.type === 'select' && param.options}
                        <select class="ete-param-select" disabled={!is_editable}
                          value={String(params[param.key] ?? param.default ?? '')}
                          onchange={(e) => save_param(param.key, (e.target as HTMLSelectElement).value)}>
                          {#each param.options as opt}
                            <option value={String(opt.value)}>{opt.label}</option>
                          {/each}
                        </select>
                      {:else if param.type === 'number'}
                        <input class="ete-param-input" type="number"
                          value={params[param.key] ?? param.default ?? ''}
                          min={param.min} max={param.max} step={param.step}
                          disabled={!is_editable}
                          onblur={(e) => save_param(param.key, (e.target as HTMLInputElement).value)} />
                      {:else if param.type === 'text'}
                        <textarea class="ete-param-textarea" rows="2"
                          disabled={!is_editable}
                          onblur={(e) => save_param(param.key, (e.target as HTMLTextAreaElement).value)}>{String(params[param.key] ?? '')}</textarea>
                      {:else}
                        <input class="ete-param-input" type="text"
                          value={String(params[param.key] ?? param.default ?? '')}
                          disabled={!is_editable}
                          onblur={(e) => save_param(param.key, (e.target as HTMLInputElement).value)} />
                      {/if}
                    </div>
                  {/if}
                {/each}
              {/each}
            {:else if display_params.length > 0}
              {#each display_params as [key, value] (key)}
                <div class="ete-param-row">
                  <label class="ete-param-label">{key}</label>
                  {#if is_editable}
                    <input class="ete-param-input" type="text"
                      value={typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')}
                      onblur={(e) => save_param(key, (e.target as HTMLInputElement).value)} />
                  {:else}
                    <span class="ete-param-value">{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')}</span>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        </div>

      <!-- Monitor tab -->
      {:else if active_tab === 'monitor'}
        <div class="ete-monitor-tab">
          {#await import('./NodeStatusPanel.svelte') then mod}
            <mod.default
              mode="task"
              task_id={task_id ?? undefined}
              node_id={task_id ?? ''}
              node_type={task.task_type}
              node_label={task.name ?? task.task_type}
              {workflow_id}
              onview_file={(id, filename) => {
                open_file_editor(filename)
              }}
            />
          {/await}
        </div>
      {/if}
    </div>

    <!-- Footer info -->
    <div class="ete-footer">
      {#if task.hpc_job_id}
        <span class="ete-footer-item">{t(`workflow.job_label`, { id: task.hpc_job_id })}</span>
      {/if}
      {#if task.retry_count > 0}
        <span class="ete-footer-item">{t(`workflow.retries_count`, { n: task.retry_count })}</span>
      {/if}
      {#if task.created_at}
        <span class="ete-footer-item">{new Date(task.created_at).toLocaleString()}</span>
      {/if}
    </div>

    <!-- File Editor Modal (Monaco / VSCode style) -->
    {#if show_file_editor}
      <div class="ete-file-overlay">
        <div class="ete-file-header">
          <span class="ete-file-path" title={file_editor_path}>{file_editor_path}</span>
          <button class="ete-file-close" onclick={() => { show_file_editor = false }} title={t(`workflow.close_esc`)}>
            &times;
          </button>
        </div>
        <div class="ete-file-body">
          {#await import('$lib/structure/MonacoEditorPanel.svelte') then mod}
            <mod.default
              content={file_editor_content}
              filename={file_editor_path}
              readonly={!is_editable}
              onsave={async (content) => {
                if (!task_id) return
                file_editor_saving = true
                try {
                  await put_engine_task_file_content(task_id, file_editor_path, content)
                  file_editor_content = content
                  show_file_editor = false
                } catch (e) {
                  error = e instanceof Error ? e.message : String(e)
                } finally {
                  file_editor_saving = false
                }
              }}
            />
          {/await}
        </div>
      </div>
    {/if}

    <!-- Full Structure Editor Modal -->
    <StructureEditModal
      bind:show={show_structure_modal}
      label={modal_label}
      readonly={modal_readonly}
      bind:is_trajectory={modal_is_trajectory}
      bind:trajectory={modal_trajectory}
      bind:structure={modal_structure}
      initial_generated={modal_initial_generated}
      scene_props={modal_scene_props}
      vibration={modal_vibration}
      initial_bulk={modal_bulk}
      initial_panel={modal_initial_panel}
      adsorption_sites={modal_adsorption_sites}
      {StructureEditorComponent}
      {TrajectoryEditorComponent}
      onconfirm={() => {
        // No separate confirm action needed
      }}
      onclose={() => { show_structure_modal = false }}
      onsave={() => {
        if (modal_structure && is_editable) {
          handle_structure_change(modal_structure)
        }
        show_structure_modal = false
      }}
    />
  {/if}
</div>

<style>
  /* ── Root ── */
  .ete-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--surface-bg, #111);
    color: var(--text-color, #e5e5e5);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    overflow: hidden;
  }

  /* ── Empty / Loading / Error states ── */
  .ete-empty,
  .ete-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 100%;
    color: var(--text-color-dim, #666);
    font-size: 12px;
  }
  .ete-empty-icon {
    font-size: 28px;
    opacity: 0.4;
  }
  .ete-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 100%;
    color: var(--danger-color, #ef4444);
    font-size: 12px;
    padding: 16px;
    text-align: center;
  }
  .ete-error-icon {
    font-size: 24px;
  }
  .ete-retry-btn {
    margin-top: 4px;
    padding: 4px 12px;
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: var(--danger-color, #ef4444);
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
  }
  .ete-retry-btn:hover {
    background: rgba(239, 68, 68, 0.25);
  }

  /* ── Header ── */
  .ete-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px 6px;
    border-bottom: 1px solid var(--border-color, #333);
  }
  .ete-header-info {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .ete-title {
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ete-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 3px;
    color: var(--text-color-bright, #fff);
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .ete-close-btn {
    background: none;
    border: none;
    color: var(--text-color-muted, #888);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    flex-shrink: 0;
  }
  .ete-close-btn:hover {
    color: var(--text-color-bright, #fff);
  }

  /* ── Subtitle ── */
  .ete-subtitle {
    padding: 0 12px 6px;
    font-size: 11px;
    color: var(--text-color-muted, #888);
  }

  /* ── Review banner ── */
  .ete-review-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(245, 158, 11, 0.12);
    border-top: 1px solid rgba(245, 158, 11, 0.25);
    border-bottom: 1px solid rgba(245, 158, 11, 0.25);
    font-size: 11px;
    color: var(--warning-color, #f59e0b);
  }
  .ete-confirm-btn {
    padding: 4px 12px;
    background: var(--warning-color, #f59e0b);
    border: none;
    color: var(--bg-on-accent, #000);
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .ete-confirm-btn:hover {
    background: var(--warning-hover, #fbbf24);
  }
  .ete-confirm-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* ── Error banner ── */
  .ete-error-banner {
    padding: 6px 12px;
    background: rgba(239, 68, 68, 0.1);
    border-bottom: 1px solid rgba(239, 68, 68, 0.2);
    font-size: 11px;
    color: var(--danger-color, #ef4444);
    word-break: break-word;
  }

  /* ── Tab bar ── */
  .ete-tabs {
    display: flex;
    border-bottom: 1px solid var(--border-color, #333);
    padding: 0 8px;
    flex-shrink: 0;
  }
  .ete-tab {
    padding: 7px 14px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-color-muted, #888);
    font-size: 12px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .ete-tab:hover {
    color: var(--text-color, #ccc);
  }
  .ete-tab-active {
    color: var(--text-color, #e5e5e5);
    border-bottom-color: var(--accent-color, #4fc3f7);
  }

  /* ── Content area ── */
  .ete-content {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  /* ── Structure tab ── */
  .ete-structure-tab {
    display: flex;
    flex-direction: column;
  }
  .ete-preview-viewport {
    height: 280px;
    background: var(--page-bg, #0a0a0a);
    position: relative;
    overflow: visible;
    border-bottom: 1px solid var(--border-color, #333);
  }
  .ete-preview-viewport :global(.structure-canvas-container) {
    overflow: visible !important;
  }
  .ete-preview-empty {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-color-dim, #555);
    font-size: 12px;
  }
  .ete-structure-actions {
    display: flex;
    gap: 6px;
    padding: 8px 12px;
  }
  .ete-action-btn {
    flex: 1;
    padding: 5px 10px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--border-color, #333);
    color: var(--text-color, #ccc);
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    transition: all 0.15s;
  }
  .ete-action-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: var(--text-color-dim, #555);
    color: var(--text-color-bright, #fff);
  }
  .ete-structure-info {
    padding: 4px 12px 8px;
    font-size: 11px;
    color: var(--text-color-muted, #888);
  }

  /* ── Task-specific tool panes ── */
  .ete-tool-section {
    border-top: 1px solid var(--border-color, #333);
    padding: 0;
  }
  .ete-tool-header {
    padding: 8px 12px 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--accent-color, #3b82f6);
  }

  /* ── Parameters (inline below structure) ── */
  .ete-params-inline {
    border-top: 1px solid var(--border-color, #333);
    padding: 4px 0;
  }
  .ete-param-group {
    padding: 8px 12px 2px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--accent-color, #3b82f6);
  }
  .ete-param-select {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    background: var(--surface-bg-hover, rgba(255,255,255,0.06));
    border: 1px solid var(--border-color, #333);
    color: var(--text-color, #e5e5e5);
    border-radius: 3px;
    font-size: 12px;
  }
  .ete-param-select:focus { outline: none; border-color: var(--accent-color, #3b82f6); }
  .ete-param-textarea {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    background: var(--surface-bg-hover, rgba(255,255,255,0.06));
    border: 1px solid var(--border-color, #333);
    color: var(--text-color, #e5e5e5);
    border-radius: 3px;
    font-size: 12px;
    font-family: monospace;
    resize: vertical;
  }
  .ete-toggle-btn {
    padding: 2px 10px;
    border-radius: 3px;
    border: 1px solid var(--border-color, #444);
    background: var(--surface-bg-hover, rgba(255,255,255,0.06));
    color: var(--text-color-dim, #888);
    font-size: 11px;
    cursor: pointer;
    font-weight: 500;
  }
  .ete-toggle-btn.on {
    background: rgba(34, 197, 94, 0.15);
    border-color: rgba(34, 197, 94, 0.3);
    color: #22c55e;
  }
  .ete-params-error {
    margin: 0 12px 8px;
    padding: 6px 8px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
    border-radius: 4px;
    color: var(--danger-color, #ef4444);
    font-size: 11px;
  }
  .ete-params-saving {
    margin: 0 12px 8px;
    padding: 4px 8px;
    font-size: 11px;
    color: var(--accent-color, #4fc3f7);
  }
  .ete-params-empty {
    padding: 24px;
    text-align: center;
    color: var(--text-color-dim, #666);
    font-size: 12px;
  }
  .ete-params-list {
    display: flex;
    flex-direction: column;
  }
  .ete-param-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }
  .ete-param-row:hover {
    background: rgba(255, 255, 255, 0.02);
  }
  .ete-param-label {
    flex: 0 0 120px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-color-muted, #aaa);
    font-family: 'SF Mono', 'Fira Code', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ete-param-input {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--border-color, #333);
    color: var(--text-color, #e5e5e5);
    border-radius: 3px;
    font-size: 12px;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .ete-param-input:focus {
    outline: none;
    border-color: var(--accent-color, #4fc3f7);
    background: rgba(255, 255, 255, 0.08);
  }
  .ete-param-value {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--text-color, #ccc);
    font-family: 'SF Mono', 'Fira Code', monospace;
    word-break: break-all;
  }

  /* ── Monitor tab ── */
  .ete-monitor-tab {
    min-height: 300px;
  }

  /* ── Footer ── */
  .ete-footer {
    display: flex;
    gap: 12px;
    padding: 6px 12px;
    border-top: 1px solid var(--border-color, #333);
    font-size: 10px;
    color: var(--text-color-dim, #666);
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .ete-footer-item {
    white-space: nowrap;
  }

  /* ── Primary action button ── */
  .ete-action-btn.primary { background: var(--accent-color, #3b82f6); color: var(--text-color-bright, #fff); border-color: var(--accent-color, #3b82f6); font-weight: 600; }
  .ete-action-btn.primary:hover { background: var(--accent-hover-color, #2563eb); }

  /* ── File Editor Modal ── */
  .ete-file-overlay { position: fixed; inset: 0; z-index: 200; background: light-dark(#fff, #0a0a0a); display: flex; flex-direction: column; }
  .ete-file-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 16px; border-bottom: 1px solid light-dark(#d1d5db, #333); background: light-dark(#f3f5f7, #181b20); flex-shrink: 0; }
  .ete-file-path { font-family: monospace; font-size: 13px; color: light-dark(#1f2937, #e5e7eb); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; font-weight: 600; }
  .ete-file-close { padding: 4px 12px; background: light-dark(#fff, rgba(255,255,255,0.04)); border: 1px solid light-dark(#9ca3af, #4b5563); border-radius: 5px; color: light-dark(#1f2937, #e5e7eb); font-size: 20px; line-height: 1; cursor: pointer; flex-shrink: 0; font-weight: 700; }
  .ete-file-close:hover { background: light-dark(#fee2e2, #7f1d1d); border-color: #ef4444; color: #ef4444; }
  .ete-file-body { flex: 1; min-height: 0; display: flex; width: 100%; }
  .ete-file-body > :global(*) { flex: 1; min-width: 0; }
  .ete-file-textarea { flex: 1; background: var(--input-bg, #0d0d0d); color: var(--text-color, #e5e5e5); border: none; padding: 12px 16px; font-family: 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace; font-size: 13px; line-height: 1.5; resize: none; outline: none; tab-size: 4; }
  .ete-save-btn { padding: 4px 12px; background: var(--accent-color, #3b82f6); border: 1px solid var(--accent-color, #3b82f6); color: var(--text-color-bright, #fff); border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .ete-save-btn:hover { background: var(--accent-hover-color, #2563eb); }
  .ete-save-btn:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
