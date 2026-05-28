<!--
  ImportWorkflowDialog — Modal dialog for importing workflows from templates,
  JSON files (atomate2 Flows), or Python source (quacc/atomate2 code).

  Three tabs:
  1. Templates — browse and import pre-built workflow templates from CatGo, atomate2, or quacc
  2. Import from JSON — upload or paste an atomate2 Flow JSON for conversion
  3. Import from Python — paste quacc/atomate2 Python code for AST-based conversion

  Imported nodes receive new unique IDs (preserving internal edge references)
  and are positioned relative to the current viewport center.

  @example
  <ImportWorkflowDialog
    bind:show={show_import}
    onimport={(graph) => append_nodes(graph.nodes, graph.edges)}
  />
-->
<script lang="ts">
  import '$lib/dialog-shared.css'
  import { API_BASE } from '$lib/api/config'
  import { uid, TEMPLATES, TEMPLATE_GROUPS, type WfNode, type WfEdge } from '../graph-model'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('workflow')

  /**
   * Props for ImportWorkflowDialog.
   * @prop show — bindable boolean controlling dialog visibility
   * @prop onimport — callback invoked with the imported graph (nodes + edges with new IDs)
   */
  let {
    show = $bindable(false),
    onimport,
  }: {
    /** Controls dialog visibility (bindable). */
    show: boolean
    /** Called when user confirms an import. Receives nodes/edges with fresh IDs. */
    onimport?: (graph: { nodes: WfNode[]; edges: WfEdge[] }) => void
  } = $props()

  // ─── Tab state ───
  type Tab = 'templates' | 'json' | 'python'
  let active_tab = $state<Tab>('templates')

  // ─── Templates tab state ───
  type TemplateSource = 'catgo' | 'atomate2' | 'quacc'
  let template_source = $state<TemplateSource>('catgo')
  let selected_template_key = $state<string | null>(null)

  /** Remote templates fetched from atomate2/quacc API endpoints. */
  let remote_templates = $state<Array<{
    id: string
    name: string
    description: string
    category?: string
    tags?: string[]
    graph_json?: string
  }>>([])
  let remote_loading = $state(false)
  let remote_error = $state('')

  // ─── JSON tab state ───
  let json_text = $state('')
  let json_file_name = $state('')
  let json_converting = $state(false)
  let json_result = $state<{ nodes: WfNode[]; edges: WfEdge[] } | null>(null)
  let json_warnings = $state<string[]>([])
  let json_error = $state('')

  // ─── Python tab state ───
  let python_text = $state(`# Paste your quacc or atomate2 flow code here\n# Example:\n#   from quacc.recipes.vasp.core import relax_job, static_job\n#   result1 = relax_job(atoms)\n#   result2 = static_job(result1["atoms"])\n`)
  let python_converting = $state(false)
  let python_result = $state<{ nodes: WfNode[]; edges: WfEdge[] } | null>(null)
  let python_warnings = $state<string[]>([])
  let python_error = $state('')

  // ─── Drag-and-drop state ───
  let drag_over = $state(false)

  // ─── Derived: preview info for selected template ───
  let selected_template_graph = $derived.by(() => {
    if (!selected_template_key) return null
    if (template_source === 'catgo') {
      const tpl = TEMPLATES[selected_template_key]
      return tpl ? { nodes: tpl.nodes, edges: tpl.edges } : null
    }
    // Remote template — look up in remote_templates
    const rt = remote_templates.find(t => t.id === selected_template_key)
    if (rt?.graph_json) {
      try {
        return JSON.parse(rt.graph_json) as { nodes: WfNode[]; edges: WfEdge[] }
      } catch { return null }
    }
    return null
  })

  // ─── Fetch remote templates when source changes ───
  $effect(() => {
    if (template_source === 'catgo') {
      remote_templates = []
      remote_error = ''
      return
    }
    fetch_remote_templates(template_source)
  })

  /** Reset all tab state when dialog opens. */
  $effect(() => {
    if (show) {
      selected_template_key = null
      json_result = null
      json_error = ''
      json_warnings = []
      python_result = null
      python_error = ''
      python_warnings = []
    }
  })

  /**
   * Fetch templates from atomate2 or quacc API endpoints.
   * @param source - 'atomate2' or 'quacc'
   */
  async function fetch_remote_templates(source: 'atomate2' | 'quacc') {
    remote_loading = true
    remote_error = ''
    remote_templates = []
    selected_template_key = null
    try {
      const res = await fetch(`${API_BASE}/${source}/templates`)
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      const data = await res.json()
      remote_templates = Array.isArray(data) ? data : []
    } catch (err) {
      remote_error = err instanceof Error ? err.message : String(err)
    } finally {
      remote_loading = false
    }
  }

  /**
   * For remote templates that don't include graph_json in the list endpoint,
   * fetch the full template by ID.
   */
  async function fetch_full_template(source: 'atomate2' | 'quacc', template_id: string): Promise<{ nodes: WfNode[]; edges: WfEdge[] } | null> {
    try {
      const res = await fetch(`${API_BASE}/${source}/templates/${encodeURIComponent(template_id)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      // atomate2 returns graph_json as string, quacc may return graph as object
      if (data.graph) return data.graph
      if (data.graph_json) return JSON.parse(data.graph_json)
      return null
    } catch {
      return null
    }
  }

  /**
   * Generate fresh IDs for all nodes and remap edges accordingly.
   * This ensures imported nodes don't collide with existing ones.
   *
   * @param graph - source graph with template IDs
   * @returns new graph with unique IDs
   */
  function remap_ids(graph: { nodes: WfNode[]; edges: WfEdge[] }): { nodes: WfNode[]; edges: WfEdge[] } {
    const id_map: Record<string, string> = {}

    const new_nodes = graph.nodes.map(n => {
      const new_id = uid()
      id_map[n.id] = new_id
      return { ...n, id: new_id }
    })

    const new_edges = graph.edges.map(e => ({
      ...e,
      id: `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from: id_map[e.from] ?? e.from,
      to: id_map[e.to] ?? e.to,
    }))

    return { nodes: new_nodes, edges: new_edges }
  }

  /**
   * Offset node positions so they are centered around (cx, cy).
   * Computes the bounding box center of the given nodes and shifts them.
   *
   * @param nodes - nodes to reposition
   * @param cx - target center X (canvas coords)
   * @param cy - target center Y (canvas coords)
   */
  function center_nodes(nodes: WfNode[], cx: number, cy: number): WfNode[] {
    if (nodes.length === 0) return nodes
    const min_x = Math.min(...nodes.map(n => n.x))
    const max_x = Math.max(...nodes.map(n => n.x))
    const min_y = Math.min(...nodes.map(n => n.y))
    const max_y = Math.max(...nodes.map(n => n.y))
    const dx = cx - (min_x + max_x) / 2
    const dy = cy - (min_y + max_y) / 2
    return nodes.map(n => ({ ...n, x: n.x + dx, y: n.y + dy }))
  }

  /** Handle template import — fetch full graph if needed, remap IDs, fire onimport. */
  async function do_import_template() {
    if (!selected_template_key) return

    let graph = selected_template_graph

    // If remote template without graph_json in list, fetch it
    if (!graph && template_source !== 'catgo') {
      graph = await fetch_full_template(template_source as 'atomate2' | 'quacc', selected_template_key)
    }

    if (!graph) return

    const remapped = remap_ids(graph)
    // Center at a reasonable default position
    const centered = center_nodes(remapped.nodes, 400, 300)
    onimport?.({ nodes: centered, edges: remapped.edges })
    show = false
  }

  /** Handle JSON file drop or selection. */
  function handle_file(file: File) {
    json_file_name = file.name
    json_error = ''
    json_result = null
    json_warnings = []
    const reader = new FileReader()
    reader.onload = () => {
      json_text = reader.result as string
    }
    reader.onerror = () => {
      json_error = t('workflow.import_dialog_failed_read_file')
    }
    reader.readAsText(file)
  }

  /** Upload JSON to atomate2 import-flow endpoint and get converted graph. */
  async function do_convert_json() {
    json_converting = true
    json_error = ''
    json_warnings = []
    json_result = null

    try {
      // Try parsing as plain JSON first to validate
      let parsed: unknown
      try {
        parsed = JSON.parse(json_text)
      } catch {
        json_error = t('workflow.import_dialog_invalid_json')
        return
      }

      // Check if it's already a CatGo graph (has nodes + edges arrays)
      if (
        typeof parsed === 'object' && parsed !== null &&
        'nodes' in parsed && Array.isArray((parsed as Record<string, unknown>).nodes) &&
        'edges' in parsed && Array.isArray((parsed as Record<string, unknown>).edges)
      ) {
        const g = parsed as { nodes: WfNode[]; edges: WfEdge[] }
        json_result = g
        json_warnings = [t('workflow.import_dialog_catgo_graph_detected')]
        return
      }

      // Send to atomate2 import endpoint as a file upload
      const blob = new Blob([json_text], { type: 'application/json' })
      const form = new FormData()
      form.append('file', blob, json_file_name || 'flow.json')

      const res = await fetch(`${API_BASE}/atomate2/import-flow`, {
        method: 'POST',
        body: form,
      })

      if (!res.ok) {
        const detail = await res.json().catch(() => null)
        json_error = detail?.detail ?? t('workflow.import_dialog_server_error', { status: res.status })
        return
      }

      const result = await res.json()
      json_result = result as { nodes: WfNode[]; edges: WfEdge[] }

      // Extract warnings from result if present
      if ('warnings' in result && Array.isArray(result.warnings)) {
        json_warnings = result.warnings
      }
    } catch (err) {
      json_error = err instanceof Error ? err.message : String(err)
    } finally {
      json_converting = false
    }
  }

  /** Import the converted JSON result. */
  function do_import_json() {
    if (!json_result) return
    const remapped = remap_ids(json_result)
    const centered = center_nodes(remapped.nodes, 400, 300)
    onimport?.({ nodes: centered, edges: remapped.edges })
    show = false
  }

  /** Send Python source to quacc import-flow endpoint. */
  async function do_convert_python() {
    python_converting = true
    python_error = ''
    python_warnings = []
    python_result = null

    try {
      const res = await fetch(`${API_BASE}/quacc/import-flow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: python_text }),
      })

      if (!res.ok) {
        const detail = await res.json().catch(() => null)
        python_error = detail?.detail ?? t('workflow.import_dialog_server_error', { status: res.status })
        return
      }

      const result = await res.json()
      python_result = result as { nodes: WfNode[]; edges: WfEdge[] }

      if ('warnings' in result && Array.isArray(result.warnings)) {
        python_warnings = result.warnings
      }
    } catch (err) {
      python_error = err instanceof Error ? err.message : String(err)
    } finally {
      python_converting = false
    }
  }

  /** Import the converted Python result. */
  function do_import_python() {
    if (!python_result) return
    const remapped = remap_ids(python_result)
    const centered = center_nodes(remapped.nodes, 400, 300)
    onimport?.({ nodes: centered, edges: remapped.edges })
    show = false
  }

  /** Close dialog. */
  function close() {
    show = false
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog-backdrop" onclick={close} onkeydown={e => e.key === 'Escape' && close()}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="dialog-modal import-dialog" onclick={e => e.stopPropagation()}>
      <!-- Header -->
      <div class="modal-header">
        <h3 class="modal-title">{t('workflow.import_dialog_title')}</h3>
        <button class="close-btn" onclick={close}>&#x2715;</button>
      </div>

      <!-- Tab bar -->
      <div class="tab-bar">
        <button class="tab-btn" class:active={active_tab === 'templates'} onclick={() => active_tab = 'templates'}>
          {t('common.templates')}
        </button>
        <button class="tab-btn" class:active={active_tab === 'json'} onclick={() => active_tab = 'json'}>
          {t('workflow.import_dialog_from_json')}
        </button>
        <button class="tab-btn" class:active={active_tab === 'python'} onclick={() => active_tab = 'python'}>
          {t('workflow.import_dialog_from_python')}
        </button>
      </div>

      <!-- Tab content -->
      <div class="import-body">
        <!-- ──────────── Tab 1: Templates ──────────── -->
        {#if active_tab === 'templates'}
          <div class="tab-content templates-tab">
            <!-- Source selector -->
            <div class="source-selector">
              <label class="source-label">{t('workflow.import_dialog_source')}:</label>
              <div class="source-btns">
                {#each (['catgo', 'atomate2', 'quacc'] as const) as src}
                  <button
                    class="source-btn"
                    class:active={template_source === src}
                    onclick={() => { template_source = src; selected_template_key = null }}
                  >
                    {src === 'catgo' ? 'CatGo' : src}
                  </button>
                {/each}
              </div>
            </div>

            <!-- Template grid -->
            <div class="template-grid">
              {#if template_source === 'catgo'}
                <!-- CatGo built-in templates -->
                {#each TEMPLATE_GROUPS as group}
                  <div class="tmpl-section-header">{group.label}</div>
                  {#each group.keys as key}
                    {@const tpl = TEMPLATES[key]}
                    {#if tpl}
                      <button
                        class="tmpl-card-import"
                        class:selected={selected_template_key === key}
                        onclick={() => selected_template_key = key}
                      >
                        <div class="tci-name">{tpl.name}</div>
                        <div class="tci-desc">{tpl.desc}</div>
                        <div class="tci-meta">
                          <span class="tci-count">{t('workflow.import_dialog_graph_counts', { nodes: tpl.nodes.length, edges: tpl.edges.length })}</span>
                        </div>
                      </button>
                    {/if}
                  {/each}
                {/each}

              {:else if remote_loading}
                <div class="loading-msg">{t('workflow.import_dialog_loading_templates')}</div>

              {:else if remote_error}
                <div class="error-msg">{t('workflow.import_dialog_failed_load_templates', { error: remote_error })}</div>

              {:else if remote_templates.length === 0}
                <div class="empty-msg">{t('workflow.import_dialog_no_templates', { source: template_source })}</div>

              {:else}
                <!-- Remote templates (atomate2 / quacc) -->
                {#each remote_templates as tpl}
                  <button
                    class="tmpl-card-import"
                    class:selected={selected_template_key === tpl.id}
                    onclick={() => selected_template_key = tpl.id}
                  >
                    <div class="tci-name">{tpl.name}</div>
                    <div class="tci-desc">{tpl.description}</div>
                    <div class="tci-tags">
                      {#if tpl.category}
                        <span class="tag category-tag">{tpl.category}</span>
                      {/if}
                      {#if tpl.tags}
                        {#each tpl.tags as tag}
                          <span class="tag">{tag}</span>
                        {/each}
                      {/if}
                    </div>
                  </button>
                {/each}
              {/if}
            </div>

            <!-- Preview + Import footer -->
            {#if selected_template_graph}
              <div class="import-footer">
                <span class="import-summary">
                  {t('workflow.import_dialog_will_add', { nodes: selected_template_graph.nodes.length, edges: selected_template_graph.edges.length })}
                </span>
                <button class="import-btn primary" onclick={do_import_template}>{t('common.import')}</button>
              </div>
            {:else if selected_template_key}
              <div class="import-footer">
                <span class="import-summary">{t('workflow.import_dialog_select_preview')}</span>
                <button class="import-btn primary" onclick={do_import_template}>{t('common.import')}</button>
              </div>
            {/if}
          </div>

        <!-- ──────────── Tab 2: Import from JSON ──────────── -->
        {:else if active_tab === 'json'}
          <div class="tab-content json-tab">
            <p class="tab-hint">{t('workflow.import_dialog_json_hint_prefix')} <code>flow.as_dict()</code>{t('workflow.import_dialog_json_hint_suffix')}</p>

            <!-- File drop zone -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="drop-zone"
              class:drag-over={drag_over}
              ondragover={e => { e.preventDefault(); drag_over = true }}
              ondragleave={() => drag_over = false}
              ondrop={e => {
                e.preventDefault()
                drag_over = false
                const f = e.dataTransfer?.files?.[0]
                if (f) handle_file(f)
              }}
            >
              <span class="drop-icon">&#128196;</span>
              <span>{t('workflow.import_dialog_drop_json')}</span>
              <label class="file-browse-label">
                {t('workflow.import_dialog_or')} <span class="browse-link">{t('workflow.import_dialog_browse')}</span>
                <input type="file" accept=".json,application/json" class="hidden-input"
                  onchange={e => {
                    const f = (e.target as HTMLInputElement).files?.[0]
                    if (f) handle_file(f)
                  }}
                />
              </label>
              {#if json_file_name}
                <span class="file-name">{json_file_name}</span>
              {/if}
            </div>

            <!-- Paste area -->
            <label class="paste-label">{t('workflow.import_dialog_paste_json')}:</label>
            <textarea class="json-textarea" bind:value={json_text} rows={8} placeholder={'{"@module": "jobflow.core.flow", ...}'}></textarea>

            <!-- Convert button -->
            <div class="action-row">
              <button class="import-btn primary" onclick={do_convert_json} disabled={!json_text.trim() || json_converting}>
                {json_converting ? t('workflow.import_dialog_converting') : t('workflow.import_dialog_convert_preview')}
              </button>
            </div>

            <!-- Warnings -->
            {#if json_warnings.length > 0}
              <div class="warnings-box">
                {#each json_warnings as w}
                  <div class="warning-item">{w}</div>
                {/each}
              </div>
            {/if}

            <!-- Error -->
            {#if json_error}
              <div class="error-box">{json_error}</div>
            {/if}

            <!-- Conversion result preview -->
            {#if json_result}
              <div class="result-preview">
                <div class="result-summary">
                  {t('workflow.import_dialog_converted', { nodes: json_result.nodes.length, edges: json_result.edges.length })}
                </div>
                <div class="node-list-preview">
                  {#each json_result.nodes as n}
                    <span class="preview-node">{n.type}</span>
                  {/each}
                </div>
                <div class="action-row">
                  <button class="import-btn primary" onclick={do_import_json}>{t('workflow.import_dialog_import_into_workflow')}</button>
                </div>
              </div>
            {/if}
          </div>

        <!-- ──────────── Tab 3: Import from Python ──────────── -->
        {:else if active_tab === 'python'}
          <div class="tab-content python-tab">
            <p class="tab-hint">{t('workflow.import_dialog_python_hint_prefix')} <code>@flow</code> {t('workflow.import_dialog_python_hint_suffix')}</p>

            <textarea class="python-textarea" bind:value={python_text} rows={12} spellcheck={false}></textarea>

            <div class="action-row">
              <button class="import-btn primary" onclick={do_convert_python} disabled={!python_text.trim() || python_converting}>
                {python_converting ? t('workflow.import_dialog_parsing') : t('workflow.import_dialog_parse_preview')}
              </button>
            </div>

            <!-- Warnings -->
            {#if python_warnings.length > 0}
              <div class="warnings-box">
                {#each python_warnings as w}
                  <div class="warning-item">{w}</div>
                {/each}
              </div>
            {/if}

            <!-- Error -->
            {#if python_error}
              <div class="error-box">{python_error}</div>
            {/if}

            <!-- Conversion result preview -->
            {#if python_result}
              <div class="result-preview">
                <div class="result-summary">
                  {t('workflow.import_dialog_parsed', { nodes: python_result.nodes.length, edges: python_result.edges.length })}
                </div>
                <div class="node-list-preview">
                  {#each python_result.nodes as n}
                    <span class="preview-node">{n.type}</span>
                  {/each}
                </div>
                <div class="action-row">
                  <button class="import-btn primary" onclick={do_import_python}>{t('workflow.import_dialog_import_into_workflow')}</button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* ─── Dialog sizing ─── */
  .import-dialog {
    width: min(780px, 92vw);
    max-height: 85vh;
  }

  .import-body {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .tab-content {
    padding: 16px 20px;
  }

  /* ─── Source selector (segmented control) ─── */
  .source-selector {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }
  .source-label {
    font-size: 12px;
    color: var(--text-color-muted, #9ca3af);
    font-weight: 600;
  }
  .source-btns {
    display: flex;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    overflow: hidden;
  }
  .source-btn {
    padding: 5px 14px;
    background: none;
    border: none;
    border-right: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color-muted, #9ca3af);
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .source-btn:last-child { border-right: none; }
  .source-btn:hover {
    background: var(--surface-bg-hover, light-dark(#e5e7eb, #3a3a3a));
    color: var(--text-color, #eee);
  }
  .source-btn.active {
    background: var(--accent-color, light-dark(#4f46e5, cornflowerblue));
    color: #fff;
  }

  /* ─── Template grid ─── */
  .template-grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 380px;
    overflow-y: auto;
    padding-right: 4px;
  }
  .tmpl-section-header {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-color-muted, #9ca3af);
    padding: 8px 0 2px;
    margin-top: 4px;
  }
  .tmpl-card-import {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    background: var(--input-bg, light-dark(rgba(0, 0, 0, 0.03), rgba(255, 255, 255, 0.04)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    color: var(--text-color, #eee);
    transition: all 0.12s;
  }
  .tmpl-card-import:hover {
    background: var(--surface-bg-hover, light-dark(#e5e7eb, #2a2a2e));
    border-color: var(--accent-color, cornflowerblue);
  }
  .tmpl-card-import.selected {
    border-color: var(--accent-color, cornflowerblue);
    background: color-mix(in srgb, var(--accent-color, cornflowerblue) 12%, transparent);
    box-shadow: 0 0 0 1px var(--accent-color, cornflowerblue);
  }
  .tci-name {
    font-size: 13px;
    font-weight: 600;
  }
  .tci-desc {
    font-size: 11px;
    color: var(--text-color-muted, #9ca3af);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tci-meta {
    font-size: 10px;
    color: var(--text-color-dim, #666);
    margin-top: 2px;
  }
  .tci-count { opacity: 0.8; }
  .tci-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .tag {
    padding: 1px 7px;
    border-radius: 9px;
    font-size: 10px;
    background: color-mix(in srgb, var(--accent-color, cornflowerblue) 15%, transparent);
    color: var(--accent-color, cornflowerblue);
    border: 1px solid color-mix(in srgb, var(--accent-color, cornflowerblue) 25%, transparent);
  }
  .category-tag {
    background: color-mix(in srgb, #22c55e 15%, transparent);
    color: #22c55e;
    border-color: color-mix(in srgb, #22c55e 25%, transparent);
  }

  /* ─── Loading / empty / error messages ─── */
  .loading-msg, .empty-msg {
    padding: 24px;
    text-align: center;
    color: var(--text-color-muted, #9ca3af);
    font-size: 12px;
  }
  .error-msg {
    padding: 12px;
    text-align: center;
    color: var(--error-color, #ef4444);
    font-size: 12px;
  }

  /* ─── Import footer ─── */
  .import-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 12px;
    margin-top: 12px;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .import-summary {
    font-size: 12px;
    color: var(--text-color-muted, #9ca3af);
  }

  /* ─── Buttons ─── */
  .import-btn {
    padding: 7px 18px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--surface-bg, light-dark(#fff, #1c1d21));
    color: var(--text-color, #eee);
    font-family: inherit;
    transition: all 0.15s;
  }
  .import-btn:hover:not(:disabled) {
    background: var(--surface-bg-hover, light-dark(#e5e7eb, #3a3a3a));
  }
  .import-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .import-btn.primary {
    background: var(--accent-color, light-dark(#4f46e5, cornflowerblue));
    border-color: var(--accent-color, light-dark(#4f46e5, cornflowerblue));
    color: #fff;
  }
  .import-btn.primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  /* ─── Tab hints ─── */
  .tab-hint {
    font-size: 12px;
    color: var(--text-color-muted, #9ca3af);
    margin: 0 0 12px;
    line-height: 1.5;
  }
  .tab-hint code {
    background: var(--input-bg, light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08)));
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11px;
  }

  /* ─── Drop zone ─── */
  .drop-zone {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 24px;
    border: 2px dashed var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 8px;
    text-align: center;
    color: var(--text-color-muted, #9ca3af);
    font-size: 12px;
    transition: all 0.15s;
    margin-bottom: 12px;
  }
  .drop-zone.drag-over {
    border-color: var(--accent-color, cornflowerblue);
    background: color-mix(in srgb, var(--accent-color, cornflowerblue) 8%, transparent);
  }
  .drop-icon { font-size: 28px; opacity: 0.5; }
  .file-browse-label {
    cursor: pointer;
    font-size: 12px;
  }
  .browse-link {
    color: var(--accent-color, cornflowerblue);
    text-decoration: underline;
    cursor: pointer;
  }
  .hidden-input {
    display: none;
  }
  .file-name {
    font-size: 11px;
    color: var(--accent-color, cornflowerblue);
    margin-top: 4px;
  }

  /* ─── Paste / textarea ─── */
  .paste-label {
    font-size: 12px;
    color: var(--text-color-muted, #9ca3af);
    font-weight: 600;
    display: block;
    margin-bottom: 6px;
  }
  .json-textarea,
  .python-textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px;
    resize: vertical;
    tab-size: 2;
  }

  /* ─── Action row ─── */
  .action-row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }

  /* ─── Warnings ─── */
  .warnings-box {
    margin-top: 10px;
    padding: 8px 12px;
    border: 1px solid color-mix(in srgb, #f59e0b 40%, transparent);
    background: color-mix(in srgb, #f59e0b 8%, transparent);
    border-radius: 6px;
  }
  .warning-item {
    font-size: 11px;
    color: #f59e0b;
    padding: 2px 0;
  }

  /* ─── Error box ─── */
  .error-box {
    margin-top: 10px;
    padding: 8px 12px;
    border: 1px solid color-mix(in srgb, #ef4444 40%, transparent);
    background: color-mix(in srgb, #ef4444 8%, transparent);
    border-radius: 6px;
    font-size: 11px;
    color: #ef4444;
  }

  /* ─── Result preview ─── */
  .result-preview {
    margin-top: 12px;
    padding: 12px;
    border: 1px solid color-mix(in srgb, #22c55e 30%, transparent);
    background: color-mix(in srgb, #22c55e 6%, transparent);
    border-radius: 8px;
  }
  .result-summary {
    font-size: 12px;
    font-weight: 600;
    color: #22c55e;
    margin-bottom: 8px;
  }
  .node-list-preview {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 10px;
  }
  .preview-node {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    background: var(--input-bg, light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color, #eee);
  }
</style>
