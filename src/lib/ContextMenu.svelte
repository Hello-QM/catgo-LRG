<script lang="ts">
  import { Icon, type IconName } from '$lib'
  import type { HTMLAttributes } from 'svelte/elements'

  interface MenuOption {
    value: string
    icon?: string
    label?: string
    disabled?: boolean
    checked?: boolean
    inline?: boolean
  }

  // Group consecutive inline options into rows
  function group_options(options: readonly MenuOption[]): MenuOption[][] {
    const groups: MenuOption[][] = []
    let current_inline: MenuOption[] = []
    for (const opt of options) {
      if (opt.inline) {
        current_inline.push(opt)
      } else {
        if (current_inline.length > 0) {
          groups.push(current_inline)
          current_inline = []
        }
        groups.push([opt])
      }
    }
    if (current_inline.length > 0) groups.push(current_inline)
    return groups
  }
  let {
    sections,
    selected_values = {},
    on_select,
    position,
    visible,
    on_close,
    menu_element,
    ...rest
  }: HTMLAttributes<HTMLDivElement> & {
    /** Each section has a `title` (i18n-translated, used for display) and
     *  an optional `id` (stable English key used for action dispatch).
     *  When `id` is omitted we fall back to `title` for back-compat — but
     *  callsites that need their actions to work across locales MUST set
     *  `id` to a stable English string (e.g. `Atom Color`), otherwise the
     *  handler's `switch (section_title)` will never match in non-English
     *  locales. */
    sections: Readonly<{ id?: string; title: string; options: readonly MenuOption[] }[]>
    selected_values?: Record<string, string>
    on_select?: (section_id: string, option: MenuOption) => void
    position: { x: number; y: number }
    visible: boolean
    on_close?: () => void
    menu_element?: HTMLDivElement
  } = $props()

  // [2025-02] Smart position: keep menu within viewport horizontally.
  // Vertically, we keep the click position and use max-height + scroll.
  function get_smart_position() {
    let { x, y } = position
    if (menu_element) {
      const rect = menu_element.getBoundingClientRect()
      if (x + rect.width > window.innerWidth) x = Math.max(10, position.x - rect.width)
    }
    // Clamp y so there's always at least 100px of space for the menu
    y = Math.min(y, window.innerHeight - 100)
    return { x: Math.max(10, x), y: Math.max(10, y) }
  }

  // Handle click outside to close
  function handle_click_outside(event: MouseEvent) {
    const target = event.target as Element
    if (visible) {
      const menu = target.closest(`.context-menu`)
      const element_selector = target.closest('.element-selector')
      if (!menu && !element_selector) on_close?.()
    }
  }

  // Handle right-click outside to close
  function handle_right_click_outside(event: MouseEvent) {
    if (!visible) return
    const menu = (event.target as Element).closest(`.context-menu`)
    const element_selector = (event.target as Element).closest('.element-selector')
    if (!menu && !element_selector) {
      event.preventDefault()
      on_close?.()
    }
  }

  // Handle keyboard shortcuts
  function handle_keydown(event: KeyboardEvent) {
    if (event.key === `Escape` && visible) on_close?.()
  }

  // Handle option selection. Dispatch with the section's stable `id` if
  // available, else fall back to the display `title`. Without this the
  // handler in context-menu-actions.ts (which `switch`es on English
  // section names like `Atom Color`) silently never matches when the
  // user has a non-English locale active — every right-click option
  // becomes a no-op.
  function handle_option_click(section: { id?: string; title: string }, option: MenuOption) {
    if (!option.disabled) on_select?.(section.id ?? section.title, option)
  }

  // [2025-02] Portal: move the menu to document.body so it escapes any
  // parent overflow:hidden / stacking context constraints (e.g. split panes).
  function portal(node: HTMLElement) {
    document.body.appendChild(node)
    return {
      destroy() {
        node.remove()
      }
    }
  }
</script>

<svelte:document
  onclick={handle_click_outside}
  oncontextmenu={handle_right_click_outside}
  onkeydown={handle_keydown}
/>

{#if visible}
  {@const { x, y } = get_smart_position()}
  {@const max_h = Math.max(100, window.innerHeight - y - 10)}
  {@const style = `position: fixed; left: ${x}px; top: ${y}px; max-height: ${max_h}px; ${rest.style ?? ``}`}
  <!-- [2025-02] use:portal moves to document.body; onwheel stops Three.js orbit steal -->
  <div use:portal {...rest} class="context-menu {rest.class ?? ``}" {style} bind:this={menu_element}
    onwheel={(e) => e.stopPropagation()}>
    {#each sections as section (section.id ?? section.title)}
      {@const grouped = group_options(section.options)}
      <div class="section">
        <div class="header">{section.title}</div>
        {#each grouped as group, gi (gi)}
          {#if group.length > 1 || group[0].inline}
            <div class="inline-group">
              {#each group as option (option.value)}
                <button
                  class="inline"
                  class:selected={selected_values[section.id ?? section.title] === option.value}
                  class:disabled={option.disabled}
                  onclick={(event) => {
                    event.stopPropagation()
                    handle_option_click(section, option)
                  }}
                >
                  {#if option.checked !== undefined}
                    <span class="checkbox">{option.checked ? '☑' : '☐'}</span>
                  {/if}
                  <span>{option.label ?? option.value}</span>
                </button>
              {/each}
            </div>
          {:else}
            {@const option = group[0]}
            <button
              class:selected={selected_values[section.id ?? section.title] === option.value}
              class:disabled={option.disabled}
              onclick={(event) => {
                event.stopPropagation()
                handle_option_click(section, option)
              }}
            >
              {#if option.checked !== undefined}
                <span class="checkbox">{option.checked ? '☑' : '☐'}</span>
              {:else if option.icon}
                <Icon icon={option.icon as IconName} />
              {/if}
              <span>{option.label ?? option.value}</span>
            </button>
          {/if}
        {/each}
      </div>
    {/each}
  </div>
{/if}

<style>
  /* [2025-02] overflow-y: auto so menu scrolls; max-height set inline based on position */
  .context-menu {
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    border-radius: var(--border-radius, 4px);
    box-shadow: 0 8px 16px -4px rgba(0, 0, 0, 0.3), 0 4px 8px -2px rgba(0, 0, 0, 0.1);
    backdrop-filter: blur(4px);
    min-width: var(--context-menu-min-width, 160px);
    overflow-x: hidden;
    overflow-y: auto;
    z-index: 100000001;
  }
  .section {
    border-bottom: 1px solid var(--border-color, #444);
  }
  .section:last-child {
    border-bottom: none;
  }
  .header {
    padding: 2px 4px;
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--text-color-muted, #999);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    background: var(--surface-bg-hover, #2a2a2a);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  button {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 8px;
    background: transparent;
    border: none;
    text-align: left;
    font-size: 0.75rem;
    color: inherit;
    cursor: pointer;
    transition: background-color 0.2s ease;
    white-space: nowrap;
    overflow: hidden;
    border-radius: 0;
  }
  button:hover:not(.disabled) {
    background: var(--surface-bg-hover, #2a2a2a);
  }
  button.selected {
    background: var(--accent-color, #0066cc);
  }
  button.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button span {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .inline-group {
    display: flex;
    padding: 0 4px;
    gap: 2px;
  }
  .inline-group button.inline {
    flex: 1;
    justify-content: center;
    padding: 4px 2px;
    gap: 3px;
    border-radius: 3px;
  }
</style>
