<script lang="ts">
  import type { PymatgenStructure } from '$lib'
  import { download } from '$lib/io/fetch'
  import NodeStatusPanel from './NodeStatusPanel.svelte'
  import NodeConfigPanel from './NodeConfigPanel.svelte'
  import StructureInputPanel from './StructureInputPanel.svelte'
  import StructureListInputPanel from './StructureListInputPanel.svelte'
  import AdsorbatePlacePanel from './AdsorbatePlacePanel.svelte'
  import StructurePreview from '$lib/structure/StructurePreview.svelte'
  import SlabGenPreview from './SlabGenPreview.svelte'
  import CalcStructurePreview from './CalcStructurePreview.svelte'
  import { NODE_DEFINITIONS } from './node-definitions'
  import { has_structure_io } from './graph-model'
  import {
    listen_status, listen_selection, read_selection, read_pinned,
    send_command, type StatusContext,
  } from './status-sync.svelte'
  import * as api from '$lib/api/workflow'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('workflow')

  const EMPTY_CTX: StatusContext = {
    workflow_id: ``, node_id: ``, node_type: ``, node_label: ``, status: ``, node_params: {},
  }

  // ─── Parse URL and determine initial mode ───
  function init(): { ctx: StatusContext; tab: `props` | `status`; mode: `follow` | `pinned` } {
    const hash = typeof window !== `undefined` ? window.location.hash : ``
    const qmark = hash.indexOf(`?`)
    const p = qmark >= 0 ? new URLSearchParams(hash.slice(qmark)) : null
    const tab = (p?.get(`tab`) as `props` | `status`) || `props`
    const mode = (p?.get(`mode`) as `follow` | `pinned`) || `follow`

    if (mode === `pinned`) {
      const node_id = p?.get(`node`) ?? ``
      const stored = node_id ? read_pinned(node_id) : null
      return { ctx: stored ?? EMPTY_CTX, tab, mode: `pinned` }
    }

    const stored = read_selection()
    return { ctx: stored ?? EMPTY_CTX, tab, mode: `follow` }
  }

  const initial = init()
  let ctx = $state<StatusContext>(initial.ctx)
  let active_tab = $state<`props` | `status`>(initial.tab)
  let mode = $state<`follow` | `pinned`>(initial.mode)

  const definition = $derived(NODE_DEFINITIONS[ctx.node_type])
  const display_label = $derived(
    (ctx.node_params?.label as string) || ctx.node_label || definition?.label || ctx.node_type
  )

  /** Whether this node type is a computation node that accepts structure input */
  const is_compute_node = $derived(
    definition && has_structure_io(ctx.node_type)
    && ctx.node_type !== `structure_input`
    && ctx.node_type !== `adsorbate_place`
    && ctx.node_type !== `slab_gen`
  )

  // ─── Listeners ───

  // Follow mode: update whenever user clicks a different node in main window
  $effect(() => {
    if (mode !== `follow`) return
    const stop = listen_selection((update) => { ctx = update })
    return stop
  })

  // Both modes: listen for status updates for the current node
  $effect(() => {
    const nid = ctx.node_id
    if (!nid) return
    const stop = listen_status((update) => { ctx = update }, nid)
    return stop
  })

  // ─── Mode toggle ───
  function toggle_mode() {
    mode = mode === `follow` ? `pinned` : `follow`
  }

  // ─── Handlers ───
  function handle_params_change(params: Record<string, unknown>) {
    ctx.node_params = params
    send_command({ type: `params_change`, node_id: ctx.node_id, params })
  }

  function handle_import() {
    if (ctx.node_id) send_command({ type: `import`, node_id: ctx.node_id })
  }

  function handle_edit_3d() {
    if (ctx.node_id) send_command({ type: `edit_3d`, node_id: ctx.node_id })
  }

  function handle_view_file(node_id: string, filename: string) {
    if (!ctx.workflow_id) return
    api.get_step_output(ctx.workflow_id, node_id, filename).then((data) => {
      const blob = new Blob([data.content], { type: `text/plain` })
      const url = URL.createObjectURL(blob)
      window.open(url, `_blank`)
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    }).catch((err) => console.error(`Failed to view file:`, err))
  }

  function handle_download(node_id: string, filename: string) {
    if (!ctx.workflow_id) return
    api.get_step_output(ctx.workflow_id, node_id, filename).then((data) => {
      download(data.content, filename, `application/octet-stream`)
    }).catch((err) => console.error(`Failed to download file:`, err))
  }
</script>

<div class="popout">
  {#if ctx.node_id && ctx.workflow_id}
    <!-- Header -->
    <header class="popout-header">
      <div class="header-left">
        {#if definition}
          <span class="header-icon" style:background="{definition.color}18" style:color={definition.color}>
            {definition.icon}
          </span>
        {/if}
        <div class="header-info">
          <div class="header-title">{display_label}</div>
          <div class="header-meta">{ctx.node_id.slice(0, 12)}</div>
        </div>
      </div>
      <div class="header-actions">
        {#if ctx.status}
          <span class="status-pill status-{ctx.status}">{ctx.status.replace(/_/g, ` `)}</span>
        {/if}
        <button
          class="mode-btn"
          class:follow={mode === `follow`}
          class:pinned={mode === `pinned`}
          onclick={toggle_mode}
          title={mode === `follow` ? `Following selection — click to pin this node` : `Pinned to this node — click to follow selection`}
        >
          {mode === `follow` ? `LIVE` : `PIN`}
        </button>
      </div>
    </header>

    <!-- Tabs -->
    <nav class="popout-nav">
      <button class="nav-tab" class:active={active_tab === `props`} onclick={() => active_tab = `props`}>
        Properties
      </button>
      <button class="nav-tab" class:active={active_tab === `status`} onclick={() => active_tab = `status`}>
        Status
      </button>
    </nav>

    <!-- Content -->
    <main class="popout-body">
      {#if active_tab === `status`}
        <NodeStatusPanel
          node_id={ctx.node_id}
          node_type={ctx.node_type}
          node_label={ctx.node_label}
          workflow_id={ctx.workflow_id}
          status={ctx.status}
          node_params={ctx.node_params}
          onview_file={handle_view_file}
          ondownload={handle_download}
        />
      {:else if definition}
        {#if ctx.node_type === `structure_input`}
          <StructureInputPanel
            node={{ id: ctx.node_id, type: ctx.node_type, params: ctx.node_params }}
            {definition}
            status={ctx.status}
            onparams_change={handle_params_change}
            onimport={handle_import}
            onedit_3d={handle_edit_3d}
          />
        {:else if ctx.node_type === `structure_list_input`}
          <StructureListInputPanel
            node={{ id: ctx.node_id, type: ctx.node_type, params: ctx.node_params }}
            {definition}
            status={ctx.status}
            onparams_change={handle_params_change}
          />
        {:else if ctx.node_type === `adsorbate_place`}
          <AdsorbatePlacePanel
            node={{ id: ctx.node_id, type: ctx.node_type, params: ctx.node_params }}
            {definition}
            status={ctx.status}
            onparams_change={handle_params_change}
            onedit_3d={handle_edit_3d}
            upstream_structure_json={ctx.upstream_structure_json}
          />
        {:else}
          <NodeConfigPanel
            node={{ id: ctx.node_id, type: ctx.node_type, params: ctx.node_params }}
            {definition}
            status={ctx.status}
            onparams_change={handle_params_change}
          >
            <!-- Slab Gen preview -->
            {#if ctx.node_type === `slab_gen`}
              <SlabGenPreview
                node_params={ctx.node_params}
                upstream_structure_json={ctx.upstream_structure_json ?? null}
                onparam_update={(key, value) => {
                  handle_params_change({ ...ctx.node_params, [key]: value })
                }}
                onstructure_generated={(json) => {
                  const cur = ctx.node_params.structure_json as string | undefined
                  if (json == cur) return
                  handle_params_change({ ...ctx.node_params, structure_json: json ?? undefined })
                }}
              />
            {/if}
            <!-- Computation node preview -->
            {#if is_compute_node}
              <CalcStructurePreview
                upstream_structure_json={ctx.upstream_structure_json ?? null}
                on_expand={handle_edit_3d}
              />
            {/if}
          </NodeConfigPanel>
        {/if}
      {/if}
    </main>
  {:else}
    <!-- Empty state -->
    <div class="popout-empty">
      <div class="empty-visual">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
          <circle cx="28" cy="28" r="26" stroke="var(--border-color, #2d333b)" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.6"/>
          <circle cx="28" cy="28" r="4" fill="var(--text-color-dim, #484f58)" opacity="0.4"/>
          <path d="M28 16v8M28 32v8M16 28h8M32 28h8" stroke="var(--text-color-dim, #484f58)" stroke-width="1" opacity="0.25"/>
        </svg>
      </div>
      <div class="empty-label">{t('workflow.status_popout_waiting_selection')}</div>
      <div class="empty-sub">{t('workflow.status_popout_click_node_hint')}</div>
    </div>
  {/if}
</div>

<style>
  :global(html), :global(body), :global(#app) {
    margin: 0; padding: 0; height: 100%;
    background: var(--dialog-bg, light-dark(#fafbfc, #1c1d21)) !important;
    overflow: hidden;
  }

  .popout {
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--dialog-bg, light-dark(#fafbfc, #1c1d21));
    color: var(--text-color, light-dark(#374151, #d1d5db));
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  /* ─── Header ─── */
  .popout-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    gap: 10px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border-color, light-dark(#e2e5e9, #272c33));
    background: var(--surface-bg, light-dark(#f3f5f7, #181b20));
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }
  .header-icon {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    flex-shrink: 0;
  }
  .header-info { min-width: 0; flex: 1; }
  .header-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-color, light-dark(#1f2937, #e6e8eb));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .header-meta {
    font-size: 9px;
    color: var(--text-color-dim, light-dark(#9ca3af, #505860));
    margin-top: 2px;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  /* ─── Mode button ─── */
  .mode-btn {
    font-size: 9px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 4px;
    border: 1px solid;
    cursor: pointer;
    font-family: inherit;
    letter-spacing: 0.5px;
    transition: all 0.15s;
  }
  .mode-btn.follow {
    background: #3b82f615;
    border-color: #3b82f640;
    color: #60a5fa;
  }
  .mode-btn.follow:hover {
    background: #3b82f630;
  }
  .mode-btn.pinned {
    background: #f59e0b15;
    border-color: #f59e0b40;
    color: #fbbf24;
  }
  .mode-btn.pinned:hover {
    background: #f59e0b30;
  }

  /* ─── Status pill ─── */
  .status-pill {
    font-size: 9px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: 12px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    flex-shrink: 0;
    white-space: nowrap;
    background: light-dark(#f3f4f6, #ffffff0d);
    color: var(--text-color-muted, #6b7280);
  }
  .status-pill.status-running  { background: #3b82f618; color: #60a5fa; }
  .status-pill.status-completed { background: #22c55e18; color: #4ade80; }
  .status-pill.status-failed   { background: #ef444418; color: #f87171; }
  .status-pill.status-queued   { background: #f59e0b18; color: #fbbf24; }
  .status-pill.status-pending  { background: #6b728018; color: #9ca3af; }
  .status-pill.status-not_converged { background: #f9731618; color: #fb923c; }
  .status-pill.status-paused   { background: #8b5cf618; color: #a78bfa; }

  /* ─── Tabs ─── */
  .popout-nav {
    display: flex;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border-color, light-dark(#e2e5e9, #272c33));
  }
  .nav-tab {
    flex: 1;
    padding: 8px 0;
    font-size: 11px;
    font-weight: 600;
    font-family: inherit;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-color-dim, light-dark(#9ca3af, #505860));
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .nav-tab:hover { color: var(--text-color, light-dark(#374151, #d1d5db)); }
  .nav-tab.active {
    color: var(--accent-color, light-dark(#4f46e5, #60a5fa));
    border-bottom-color: var(--accent-color, light-dark(#4f46e5, #60a5fa));
  }

  /* ─── Body ─── */
  .popout-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .popout-body :global(.status-panel),
  .popout-body :global(.config-panel) {
    border-radius: 0;
    box-shadow: none;
    border: none;
  }
  /* Override dialog-modal and component-scoped height/overflow for all panels inside popout —
     the popout-body handles scrolling, not the individual panels */
  .popout-body :global(.config-panel.dialog-modal),
  .popout-body :global(.config-panel) {
    max-height: none !important;
    height: auto !important;
    overflow: visible !important;
  }

  /* ─── Empty ─── */
  .popout-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 14px;
    padding: 32px;
    user-select: none;
  }
  .empty-visual { opacity: 0.7; }
  .empty-label {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-color-muted, light-dark(#6b7280, #6b7280));
  }
  .empty-sub {
    font-size: 11px;
    color: var(--text-color-dim, light-dark(#9ca3af, #505860));
    text-align: center;
    line-height: 1.6;
    max-width: 260px;
  }

  /* ─── Inline Structure Preview (computation nodes) ─── */
  .popout-struct-preview {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color, light-dark(#e2e5e9, #272c33));
  }
  .popout-preview-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .popout-preview-label {
    font-size: 9px;
    font-weight: 700;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    text-transform: uppercase;
    letter-spacing: 1.5px;
    flex: 1;
  }
  .popout-preview-atoms {
    font-size: 10px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
  }
  .popout-preview-expand {
    background: none;
    border: 1px solid color-mix(in srgb, var(--text-color, #ccc) 30%, transparent);
    color: var(--text-color, #ccc);
    cursor: pointer;
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 0.8rem;
    line-height: 1;
  }
  .popout-preview-expand:hover {
    background: color-mix(in srgb, var(--accent-color, #4fc3f7) 20%, transparent);
    border-color: var(--accent-color, #4fc3f7);
  }
  .popout-preview-viewport {
    height: 200px;
    position: relative;
    background: #111;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--text-color, #ccc) 20%, transparent);
  }
</style>
