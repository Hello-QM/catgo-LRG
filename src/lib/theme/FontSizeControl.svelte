<script lang="ts">
  import {
    DEFAULT_PANE_FONT_SIZE,
    pane_font_size_state,
    save_pane_font_size,
  } from '$lib/state.svelte'
  import type { HTMLAttributes } from 'svelte/elements'

  let { ...rest }: HTMLAttributes<HTMLDivElement> = $props()

  function handle_change(event: Event) {
    const target = event.target as HTMLInputElement
    const value = parseFloat(target.value)
    if (!isNaN(value)) {
      pane_font_size_state.size = value
      save_pane_font_size(value)
    }
  }

  function reset() {
    pane_font_size_state.size = DEFAULT_PANE_FONT_SIZE
    save_pane_font_size(DEFAULT_PANE_FONT_SIZE)
  }
</script>

<div {...rest} class="font-size-control {rest.class ?? ``}">
  <label title="Pane text size (double-click Aa to reset)">
    <span class="label-text" ondblclick={reset}>Aa</span>
    <input
      type="range"
      min={0.65}
      max={1.3}
      step={0.05}
      value={pane_font_size_state.size}
      oninput={handle_change}
    />
    <span class="size-value">{Math.round(pane_font_size_state.size * 100)}%</span>
  </label>
</div>

<style>
  .font-size-control {
    position: fixed;
    bottom: 1em;
    left: 8.5em;
    z-index: var(--theme-control-z-index, 2);
    background: var(--btn-bg);
    border: var(--pane-border);
    color: var(--text-color);
    border-radius: 5pt;
    padding: 1pt 6pt;
    backdrop-filter: blur(10px);
    transition: all 0.2s ease;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    font-size: 0.85em;
  }
  .font-size-control:hover {
    background: var(--btn-bg-hover);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }
  label {
    display: flex;
    align-items: center;
    gap: 4pt;
    cursor: pointer;
    white-space: nowrap;
  }
  .label-text {
    font-weight: 600;
    font-size: 0.9em;
    opacity: 0.7;
    cursor: pointer;
    user-select: none;
  }
  input[type='range'] {
    width: 60px;
    margin: 0;
    cursor: pointer;
  }
  .size-value {
    font-size: 0.8em;
    min-width: 2.5em;
    text-align: right;
    opacity: 0.7;
  }
</style>
