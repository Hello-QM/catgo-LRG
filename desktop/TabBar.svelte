<script lang="ts">
  import { t } from '$lib/i18n/index.svelte'
  export interface AppTab {
    id: string
    type: 'structure' | 'workflow' | 'terminal'
    label: string
    closable: boolean
    badge?: number
  }

  type LayoutType = 'single' | 'splitH' | 'splitV' | 'quad'

  interface LayoutOption {
    id: LayoutType
    label: string
    icon: string
  }

  let layout_options: LayoutOption[] = $derived([
    { id: 'single', label: t('app.layout_single'), icon: 'M3 3h18v18H3z' },
    { id: 'splitH', label: t('app.layout_split_h'), icon: 'M3 3h18v18H3zM12 3v18' },
    { id: 'splitV', label: t('app.layout_split_v'), icon: 'M3 3h18v18H3zM3 12h18' },
    { id: 'quad', label: t('app.layout_quad'), icon: 'M3 3h18v18H3zM12 3v18M3 12h18' },
  ])

  import type { Snippet } from 'svelte'

  let {
    tabs,
    active_tab_id,
    onactivate,
    onclose,
    oncloseall,
    onadd,
    layout,
    onlayoutchange,
    children,
  }: {
    tabs: AppTab[]
    active_tab_id: string
    onactivate: (id: string) => void
    onclose: (id: string) => void
    oncloseall?: () => void
    onadd: (type: 'structure' | 'workflow') => void
    layout?: LayoutType
    onlayoutchange?: (layout: LayoutType) => void
    children?: Snippet
  } = $props()

  let show_layout_menu = $state(false)
  let can_close = $derived(tabs.length > 0)

  function handle_tab_mousedown(event: MouseEvent, tab: AppTab) {
    if (event.button === 1 && can_close) {
      event.preventDefault()
      onclose(tab.id)
    }
  }

  function handle_layout_click() {
    show_layout_menu = !show_layout_menu
  }

  function handle_layout_select(id: LayoutType) {
    show_layout_menu = false
    onlayoutchange?.(id)
  }

  function handle_window_click(event: MouseEvent) {
    const target = event.target as HTMLElement
    if (show_layout_menu && !target.closest(`.layout-menu-container`)) {
      show_layout_menu = false
    }
  }

  const tab_icons: Record<string, string> = {
    structure: `M12 3L2 9l10 6 10-6-10-6zM2 17l10 6 10-6M2 13l10 6 10-6`,
    workflow: `M2 3h6v5H2zM16 3h6v5h-6zM9 16h6v5H9zM5 8v3a2 2 0 002 2h10a2 2 0 002-2V8M12 13v3`,
    terminal: `M4 17l6-5-6-5M12 19h8`,
  }

  let current_layout_option = $derived(layout_options.find(o => o.id === layout) ?? layout_options[0])
</script>

<svelte:window onclick={handle_window_click} />

<div class="tab-bar">
  <div class="tabs-scroll">
    {#each tabs as tab (tab.id)}
      <div
        class="tab"
        class:active={tab.id === active_tab_id}
        data-type={tab.type}
        onclick={() => onactivate(tab.id)}
        onmousedown={(e) => handle_tab_mousedown(e, tab)}
        title={tab.label}
        role="tab"
        tabindex="0"
        aria-selected={tab.id === active_tab_id}
        onkeydown={(e) => { if (e.key === `Enter` || e.key === ` `) { e.preventDefault(); onactivate(tab.id) } }}
      >
        <svg class="tab-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d={tab_icons[tab.type]} />
        </svg>
        <span class="tab-label">{tab.label}</span>
        {#if tab.badge}
          <span class="tab-badge">{tab.badge}</span>
        {/if}
        {#if can_close}
          <button
            class="tab-close"
            onclick={(e) => { e.stopPropagation(); onclose(tab.id) }}
            title={t('app.close_tab')}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        {/if}
      </div>
    {/each}

    <button class="add-tab-btn" onclick={() => onadd(`structure`)} title={t('app.new_tab')}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
    {#if oncloseall && tabs.length > 1}
      <button class="close-all-btn" onclick={oncloseall} title={t('app.close_all_tabs')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    {/if}
  </div>

  {#if layout !== undefined}
    <div class="layout-menu-container">
      <button class="layout-trigger" onclick={handle_layout_click} title={t('app.layout') + ': ' + current_layout_option.label}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d={current_layout_option.icon} />
        </svg>
        <span class="layout-trigger-label">{current_layout_option.label}</span>
      </button>
      {#if show_layout_menu}
        <div class="layout-menu">
          {#each layout_options as opt}
            <button
              class="layout-menu-item"
              class:active={layout === opt.id}
              onclick={() => handle_layout_select(opt.id)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d={opt.icon} />
              </svg>
              <span>{opt.label}</span>
              {#if layout === opt.id}
                <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if children}
    <div class="tab-bar-extra">
      {@render children()}
    </div>
  {/if}

</div>

<style>
  .tab-bar {
    display: flex;
    align-items: center;
    height: 32px;
    min-height: 32px;
    padding: 0 6px;
    gap: 4px;
    background: var(--page-bg, #0f1520);
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
    user-select: none;
    z-index: 100000020;
    position: relative;
  }

  .tabs-scroll {
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    flex: 1;
    min-width: 0;
    scrollbar-width: none;
  }

  .tabs-scroll::-webkit-scrollbar {
    display: none;
  }

  /* Pill-style tabs */
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    min-width: 0;
    max-width: 160px;
    background: transparent;
    border: none;
    border-top: 2px solid transparent;
    border-radius: 0 0 8px 8px;
    color: var(--text-color-muted, #6b7280);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    white-space: nowrap;
    position: relative;
  }

  .tab:hover {
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
    color: var(--text-color, #374151);
  }

  /* Active tab — accent top border + color-coded */
  .tab.active {
    border-top-color: #3b82f6;
  }
  .tab.active[data-type="structure"] {
    background: rgba(59, 130, 246, 0.12);
    color: #2563eb;
    border-top-color: #3b82f6;
  }
  .tab.active[data-type="workflow"] {
    background: rgba(245, 158, 11, 0.12);
    color: #d97706;
    border-top-color: #f59e0b;
  }
  .tab.active[data-type="terminal"] {
    background: rgba(100, 116, 139, 0.12);
    color: #475569;
    border-top-color: #64748b;
  }

  /* Dark themes: lighten active tab text */
  :global(:root[data-theme="dark"]) .tab.active[data-type="structure"],
  :global(:root[data-theme="black"]) .tab.active[data-type="structure"] {
    color: #93bbfc;
    background: rgba(59, 130, 246, 0.15);
  }
  :global(:root[data-theme="dark"]) .tab.active[data-type="workflow"],
  :global(:root[data-theme="black"]) .tab.active[data-type="workflow"] {
    color: #fbbf50;
    background: rgba(245, 158, 11, 0.15);
  }
  :global(:root[data-theme="dark"]) .tab.active[data-type="terminal"],
  :global(:root[data-theme="black"]) .tab.active[data-type="terminal"] {
    color: #94a3b8;
    background: rgba(100, 116, 139, 0.2);
  }

  .tab-icon {
    flex-shrink: 0;
    opacity: 0.45;
  }

  .tab.active .tab-icon { opacity: 1; }
  .tab.active[data-type="structure"] .tab-icon { color: #3b82f6; }
  .tab.active[data-type="workflow"] .tab-icon { color: #f59e0b; }
  .tab.active[data-type="terminal"] .tab-icon { color: #64748b; }

  :global(:root[data-theme="dark"]) .tab.active[data-type="structure"] .tab-icon,
  :global(:root[data-theme="black"]) .tab.active[data-type="structure"] .tab-icon { color: #60a5fa; }
  :global(:root[data-theme="dark"]) .tab.active[data-type="terminal"] .tab-icon,
  :global(:root[data-theme="black"]) .tab.active[data-type="terminal"] .tab-icon { color: #94a3b8; }

  .tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .tab-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: rgba(59, 130, 246, 0.15);
    color: #2563eb;
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
  }

  :global(:root[data-theme="dark"]) .tab-badge,
  :global(:root[data-theme="black"]) .tab-badge {
    background: rgba(59, 130, 246, 0.25);
    color: #93bbfc;
  }

  .tab-close {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-color-dim, #9ca3af);
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.15s, background 0.15s, color 0.15s;
  }

  .tab:hover .tab-close { opacity: 1; }

  .tab-close:hover {
    background: rgba(220, 38, 38, 0.6);
    color: white;
  }

  /* ===== Layout selector ===== */
  .layout-menu-container {
    position: relative;
    display: flex;
    align-items: center;
    padding-left: 5px;
    margin-left: 3px;
    border-left: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
  }

  .layout-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    padding: 2px 5px;
    min-width: 28px;
    background: transparent;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 6px;
    color: var(--text-color-muted, #6b7280);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
    white-space: nowrap;
  }

  .layout-trigger:hover {
    color: var(--text-color, #374151);
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
  }

  .layout-trigger-label {
    display: none;
  }

  @media (min-width: 900px) {
    .layout-trigger-label {
      display: inline;
    }
    .layout-trigger {
      justify-content: flex-start;
      gap: 5px;
      padding: 4px 8px;
      border: none;
    }
  }

  .layout-menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    min-width: 160px;
    background: var(--dialog-bg, var(--surface-bg, #1c1c2e));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 8px;
    padding: 4px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    z-index: 100000030;
  }

  .layout-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--text-color, #374151);
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .layout-menu-item:hover {
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
  }

  .layout-menu-item.active {
    color: var(--accent-color, #3b82f6);
  }

  .layout-menu-item .check-icon {
    margin-left: auto;
    color: var(--accent-color, #3b82f6);
  }

  /* ===== Extra slot (e.g. theme control) ===== */
  .tab-bar-extra {
    display: flex;
    align-items: center;
    gap: 3px;
    padding-left: 5px;
    margin-left: 3px;
    border-left: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
  }

  .tab-bar-extra :global(select),
  .tab-bar-extra :global(button) {
    font-size: 11px;
    padding: 2px 5px;
    border-radius: 4px;
    background: transparent;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    color: var(--text-color-muted, #6b7280);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }

  .tab-bar-extra :global(select.theme-control) {
    width: 108px;
  }

  .tab-bar-extra :global(select.locale-control) {
    width: 88px;
  }

  .tab-bar-extra :global(select:hover),
  .tab-bar-extra :global(button:hover) {
    color: var(--text-color, #374151);
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
  }

  /* ===== Close All button ===== */
  .close-all-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--text-color-dim, #9ca3af);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
    opacity: 0.5;
  }

  .close-all-btn:hover {
    color: #dc2626;
    background: rgba(220, 38, 38, 0.1);
    opacity: 1;
  }

  /* ===== Add button ===== */
  .add-tab-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--text-color-dim, #9ca3af);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }

  .add-tab-btn:hover {
    color: var(--text-color, #374151);
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
  }
</style>
