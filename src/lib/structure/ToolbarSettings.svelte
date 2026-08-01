<script lang="ts">
  import Icon from '$lib/Icon.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { click_outside } from 'svelte-multiselect'
  import {
    TOOLBAR_GROUPS,
    TOOLBAR_TOOLS,
    pane_toolbar,
    register_toolbar_pane,
    reset_toolbar,
    set_toolbar_collapsed,
    set_toolbar_tool_visible,
    type ToolbarToolId,
  } from './toolbar-state.svelte'

  load_i18n_module(`structure`)

  let {
    pane_key,
    available_tools = [],
    forced_hidden = [],
  }: {
    pane_key: string
    available_tools?: ToolbarToolId[]
    forced_hidden?: ToolbarToolId[]
  } = $props()

  let menu_open = $state(false)
  let customize_button: HTMLButtonElement | undefined = $state()
  let prefs = $derived(pane_toolbar(pane_key))
  let configurable = $derived(available_tools.filter((id) => !forced_hidden.includes(id)))

  $effect(() => register_toolbar_pane(pane_key))

  function close_menu(restore_focus = false) {
    menu_open = false
    if (restore_focus) queueMicrotask(() => customize_button?.focus())
  }

  function handle_keydown(event: KeyboardEvent) {
    if (event.key === `Escape` && menu_open) {
      event.preventDefault()
      close_menu(true)
    }
  }
</script>

<svelte:window onkeydown={handle_keydown} />

<div class="toolbar-settings" data-toolbar-settings={pane_key}>
  {#if !prefs.collapsed}
    <button
      bind:this={customize_button}
      type="button"
      class="toolbar-settings-button"
      class:active={menu_open}
      aria-label={t(`structure.toolbar_customize`)}
      title={t(`structure.toolbar_customize`)}
      aria-haspopup="dialog"
      aria-expanded={menu_open}
      onclick={() => menu_open = !menu_open}
    ><Icon icon="Settings" /></button>
  {/if}

  <button
    type="button"
    class="toolbar-collapse-button"
    aria-label={prefs.collapsed ? t(`structure.toolbar_expand`) : t(`structure.toolbar_collapse`)}
    title={prefs.collapsed ? t(`structure.toolbar_expand`) : t(`structure.toolbar_collapse`)}
    aria-expanded={!prefs.collapsed}
    onclick={() => {
      close_menu()
      set_toolbar_collapsed(pane_key, !prefs.collapsed)
    }}
  ><Icon icon={prefs.collapsed ? `Expand` : `Collapse`} /></button>

  {#if menu_open}
    <div
      class="toolbar-settings-menu"
      role="dialog"
      aria-label={t(`structure.toolbar_preferences`)}
      {@attach click_outside({ callback: () => close_menu() })}
    >
      <div class="toolbar-settings-title">{t(`structure.toolbar_preferences`)}</div>
      {#each TOOLBAR_GROUPS as group (group.id)}
        {@const tools = TOOLBAR_TOOLS.filter((tool) =>
          tool.group === group.id && configurable.includes(tool.id))}
        {#if tools.length > 0}
          <fieldset>
            <legend>{t(group.label_key)}</legend>
            {#each tools as tool (tool.id)}
              <label>
                <input
                  type="checkbox"
                  checked={!prefs.hidden.includes(tool.id)}
                  onchange={(event) => set_toolbar_tool_visible(
                    pane_key,
                    tool.id,
                    (event.currentTarget as HTMLInputElement).checked,
                  )}
                />
                <span>{t(tool.label_key)}</span>
              </label>
            {/each}
          </fieldset>
        {/if}
      {/each}
      <button type="button" class="toolbar-reset" onclick={() => reset_toolbar(pane_key)}>
        {t(`structure.toolbar_reset`)}
      </button>
    </div>
  {/if}
</div>

<style>
  .toolbar-settings {
    position: relative;
    display: contents;
  }

  button {
    display: grid;
    place-items: center;
    padding: 4pt;
    border: 0;
    border-radius: 3pt;
    background: transparent;
    color: inherit;
    font-size: clamp(0.9em, 1.8cqmin, 1.3em);
    cursor: pointer;
    transition: background-color 0.2s;
  }

  button:hover {
    background-color: color-mix(in srgb, currentColor 10%, transparent);
  }

  button.active {
    color: var(--accent-color, #4f7cff);
    background: color-mix(in srgb, var(--accent-color, #4f7cff) 16%, transparent);
  }

  .toolbar-settings-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    width: min(20em, calc(100vw - 24px));
    max-height: min(70vh, 34em);
    overflow: auto;
    z-index: 100000020;
    padding: 10px;
    border: 1px solid var(--border-color, #555);
    border-radius: 8px;
    background: var(--pane-bg, var(--background-color, #242424));
    color: var(--text-color, inherit);
    box-shadow: 0 8px 28px rgb(0 0 0 / 28%);
  }

  .toolbar-settings-title {
    margin: 0 2px 8px;
    font-weight: 650;
  }

  fieldset {
    margin: 0 0 8px;
    padding: 4px 8px 7px;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    border-radius: 6px;
  }

  legend {
    padding: 0 4px;
    font-size: 0.78em;
    font-weight: 650;
    color: var(--text-color-muted, #999);
  }

  label {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    cursor: pointer;
    font-size: 0.88em;
  }

  label input {
    margin: 0;
  }

  .toolbar-reset {
    width: 100%;
    min-height: 30px;
    margin-top: 3px;
    border: 1px solid var(--border-color, #555);
    border-radius: 5px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 0.88em;
  }

  @media (max-width: 560px) {
    .toolbar-settings-menu {
      position: fixed;
      top: 72px;
      left: 50%;
      right: auto;
      transform: translateX(-50%);
      max-height: calc(100dvh - 96px);
    }
  }
</style>
